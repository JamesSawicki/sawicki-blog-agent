import Anthropic from '@anthropic-ai/sdk'
import fetch from 'node-fetch'
import dotenv from 'dotenv'

// Load .env file in development.
// In Cloud Run, these come from Secret Manager instead.
dotenv.config()

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY
const GITHUB_TOKEN = process.env.GITHUB_TOKEN
const FRED_API_KEY = process.env.FRED_API_KEY
const GITHUB_OWNER = process.env.GITHUB_OWNER
const GITHUB_REPO = process.env.GITHUB_REPO
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main'

// ─────────────────────────────────────────────
// STEP 1: FETCH MORTGAGE RATE DATA FROM FRED
// FRED series codes:
//   MORTGAGE30US — 30-year fixed rate, weekly
//   MORTGAGE15US — 15-year fixed rate, weekly
// ─────────────────────────────────────────────
async function fetchMortgageRates() {
  console.log('Fetching mortgage rate data from FRED...')

  const baseUrl = 'https://api.stlouisfed.org/fred/series/observations'
  const params = new URLSearchParams({
    api_key: FRED_API_KEY,
    file_type: 'json',
    sort_order: 'desc',
    limit: '4', // last 4 weeks
  })

  // Fetch 30-year rate
  const res30 = await fetch(`${baseUrl}?${params}&series_id=MORTGAGE30US`)
  const data30 = await res30.json()

  // Fetch 15-year rate
  const res15 = await fetch(`${baseUrl}?${params}&series_id=MORTGAGE15US`)
  const data15 = await res15.json()

  const latest30 = data30.observations[0]
  const prev30 = data30.observations[1]
  const latest15 = data15.observations[0]

  return {
    thirtyYear: {
      current: parseFloat(latest30.value),
      previous: parseFloat(prev30.value),
      change: (parseFloat(latest30.value) - parseFloat(prev30.value)).toFixed(2),
      date: latest30.date,
    },
    fifteenYear: {
      current: parseFloat(latest15.value),
      date: latest15.date,
    }
  }
}

// ─────────────────────────────────────────────
// STEP 2: BUILD THE PROMPT AND CALL CLAUDE
// ─────────────────────────────────────────────
async function generatePost(rates) {
  console.log('Generating blog post with Claude...')

  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY })

  const today = new Date()
  const dateStr = today.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric'
  })

  const rateDirection = rates.thirtyYear.change > 0 ? 'up' : 'down'
  const rateChange = Math.abs(rates.thirtyYear.change)

  const systemPrompt = `You are a real estate market analyst writing for The Sawicki Group, 
a Twin Cities real estate team at Coldwell Banker Realty. Your writing is:
- Direct and data-driven, not salesy
- Helpful to buyers and sellers making real decisions
- Focused on the Minneapolis and Saint Paul metro area
- Written in first person plural ("we", "our market")
- Free of the EM dash (—) , use '-' instead
- Uses proper Markdown formatting: ## for section headings, **bold** for emphasis
- Professional but conversational

Always end posts with a call to action inviting readers to reach out to discuss 
their specific situation.`

  const userPrompt = `Write a real estate market update blog post for ${dateStr}.

Current mortgage rate data from the Federal Reserve:
- 30-year fixed rate: ${rates.thirtyYear.current}% (as of ${rates.thirtyYear.date})
- Previous week: ${rates.thirtyYear.previous}% (${rateDirection} ${rateChange}%)
- 15-year fixed rate: ${rates.fifteenYear.current}%

Write a post of approximately 500-600 words that:
1. Opens with the current rate environment and what changed this week
2. Explains what this means practically for Twin Cities buyers (monthly payment impact)
3. Gives context — are these rates historically high, low, or middle of the road?
4. Offers tactical advice for buyers and sellers in the current environment
5. Closes with a call to action

Format the post with a clear title on the first line, then the body.
Use section headers to break up the content.
Write for someone who is smart but not a real estate expert.`

const response = await client.messages.create({
  model: 'claude-sonnet-5',
  max_tokens: 1500,
  thinking: { type: 'disabled' },
  system: systemPrompt,
  messages: [{ role: 'user', content: userPrompt }]
})

if (response.stop_reason === 'max_tokens') {
  throw new Error('Blog post generation was truncated — max_tokens too low')
}
  return response.content[0].text
}

// ─────────────────────────────────────────────
// STEP 3: FORMAT AS MARKDOWN WITH FRONTMATTER
// ─────────────────────────────────────────────
function formatAsMarkdown(postText, rates) {
  const today = new Date()

  // Extract the title from the first line of Claude's output
  const lines = postText.trim().split('\n')
  const title = lines[0].replace(/^#+ /, '').trim()
  const body = lines.slice(1).join('\n').trim()

  // Generate a URL-friendly slug from the title and date
  const month = today.toLocaleDateString('en-US', { month: 'long' }).toLowerCase()
  const year = today.getFullYear()
  const slug = `rate-update-${month}-${year}`

  // Build the ISO date string for frontmatter
  const isoDate = today.toISOString().split('T')[0]

  const frontmatter = `---
title: "${title}"
date: ${isoDate}
tag: Rates
excerpt: "30-year fixed rates at ${rates.thirtyYear.current}% this week. Here is what the latest mortgage rate data means for Twin Cities buyers and sellers."
author: AI
draft: true
---`

  return { content: `${frontmatter}\n\n${body}`, slug }
}

// ─────────────────────────────────────────────
// STEP 4: COMMIT TO GITHUB VIA API
// ─────────────────────────────────────────────
async function commitToGitHub(content, slug) {
  console.log(`Committing draft post to GitHub as ${slug}.md...`)

  const path = `src/content/blog/${slug}.md`
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`

  // Base64 encode the content — GitHub API requires this
  const encoded = Buffer.from(content).toString('base64')

// Check if the file already exists ON THE TARGET BRANCH
let sha = undefined
const checkRes = await fetch(`${url}?ref=${GITHUB_BRANCH}`, {
  headers: {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
  }
})

if (checkRes.ok) {
  const existing = await checkRes.json()
  sha = existing.sha
  console.log('File exists on branch, updating...')
} else {
  console.log('New file, creating...')
}

  // Create or update the file
  const body = {
    message: `chore: add AI draft post - ${slug}`,
    content: encoded,
    branch: GITHUB_BRANCH,
    ...(sha && { sha }) // include sha only if updating an existing file
  }

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const error = await res.json()
    throw new Error(`GitHub API error: ${JSON.stringify(error)}`)
  }

  const result = await res.json()
  console.log(`✓ Post committed: ${result.content.html_url}`)
  return result
}

// ─────────────────────────────────────────────
// MAIN — runs the full pipeline
// ─────────────────────────────────────────────
async function main() {
  console.log('Starting Sawicki Group blog agent...')

  try {
    // Validate environment
    const required = ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'FRED_API_KEY', 'GITHUB_OWNER', 'GITHUB_REPO']
    const missing = required.filter(key => !process.env[key])
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
    }

    // Run the pipeline
    const rates = await fetchMortgageRates()
    console.log(`Current 30-year rate: ${rates.thirtyYear.current}%`)

    const postText = await generatePost(rates)
    const { content, slug } = formatAsMarkdown(postText, rates)

    await commitToGitHub(content, slug)

    console.log('Blog agent completed successfully.')
    process.exit(0)

  } catch (error) {
    console.error('Blog agent failed:', error)
    process.exit(1)
  }
}

main()