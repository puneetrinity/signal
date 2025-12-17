<div align="center">

# Signal

### AI-Powered Talent Discovery by VantaHire

Find the right professionals instantly. Search the web like an expert recruiter using AI, real-time data, and public sources.

[Features](#-features) • [Quick Start](#-quick-start) • [How It Works](#-how-it-works) • [Deploy](#-deploy)

</div>

---

## What is Signal?

Signal is an open-source professional discovery platform that helps you find hard-to-reach talent using AI and real-time web search.

**Stop guessing. Start finding.**

Traditional people search tools are slow, expensive, and opaque. Signal gives you direct access to professionals on the open web, ranked and explained — no walled gardens, no outdated databases.

Just type what you need:
- "10 AI engineers in San Francisco"
- "Senior backend developers with Python in Berlin"
- "Fintech founders in New York"

## Features

### Natural Language Search
Search for professionals using plain English. No complex filters or Boolean operators needed.

### Real-Time Web Search
Signal searches the live web using multiple providers (Brave Search, SearXNG) — no stale databases.

### AI-Powered Query Parsing
Queries are intelligently parsed using Groq (LLaMA) or Google Gemini to understand roles, skills, locations, and intent.

### Identity Discovery & Enrichment
Cross-reference professionals across trusted public sources:
- **Engineering:** GitHub, Stack Overflow, npm packages
- **Research:** Google Scholar, ORCID, patents
- **Business:** Leadership roles, founding history
- **Public presence:** Writing, talks, community

### Confidence Scoring
Every match includes evidence and a confidence score — so you know why it's a match.

### Privacy-Respecting Design
- Uses public web data only
- No scraping of private profiles
- Analyzes on demand, not in bulk
- Human-in-the-loop confirmation for identity linking

## Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL database
- API keys for search and AI providers

### Installation

1. **Clone the repository**
```bash
git clone https://github.com/puneetrinity/signal.git
cd signal
```

2. **Install dependencies**
```bash
npm install
```

3. **Set up environment variables**
```bash
cp .env.example .env
```

Edit `.env` with your credentials:
```env
# Database (PostgreSQL)
DATABASE_URL="postgresql://..."

# Search Provider (choose one)
SEARCH_PROVIDER="brave"  # or "searxng"
BRAVE_API_KEY="your-brave-api-key"

# AI Parser (choose one)
PARSER_PROVIDER="groq"  # or "gemini"
GROQ_API_KEY="your-groq-api-key"

# Enable v2 mode
USE_NEW_DISCOVERY="true"

# Optional: Redis for caching
REDIS_URL=""
```

4. **Set up database**
```bash
npx prisma generate
npx prisma db push
```

5. **Run the development server**
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

## How It Works

### 1. Describe Who You're Looking For
Use natural language — roles, skills, locations, seniority.

### 2. Signal Searches the Web
We discover relevant public profiles using advanced search intelligence across multiple providers.

### 3. Deep Research on Demand
Click any result to analyze public sources like GitHub, research papers, patents, and more.

### 4. Clear Confidence, Explained
Every profile includes evidence and a confidence score — so you know why it's a match.

## Architecture

```
User Query
    ↓
AI Parser (Groq/Gemini)
    ↓
Search Provider (Brave/SearXNG)
    ↓
Candidate Capture (URL + snippets only)
    ↓
Identity Discovery (GitHub, Scholar, etc.)
    ↓
Confidence Scoring + Evidence
    ↓
Results with Explanations
```

### v2 Compliant Design

Signal v2 follows a privacy-respecting architecture:
- **No scraping:** Only captures LinkedIn URLs and public search snippets
- **Bridge-first discovery:** Finds identities through public cross-references
- **Human-in-the-loop:** Identity links require confirmation before storing PII
- **Audit logging:** All actions are tracked for compliance

## Deploy

### Railway (Recommended)

1. Create a Railway project
2. Add PostgreSQL service
3. Connect your GitHub repo
4. Set environment variables:
   - `DATABASE_URL` (auto-provided by Railway PostgreSQL)
   - `BRAVE_API_KEY`
   - `GROQ_API_KEY`
   - `SEARCH_PROVIDER="brave"`
   - `PARSER_PROVIDER="groq"`
   - `USE_NEW_DISCOVERY="true"`
5. Deploy

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SEARCH_PROVIDER` | Yes | `brave`, `searxng`, or `brightdata` |
| `BRAVE_API_KEY` | If using Brave | Brave Search API key |
| `SEARXNG_URL` | If using SearXNG | SearXNG instance URL |
| `PARSER_PROVIDER` | Yes | `groq` or `gemini` |
| `GROQ_API_KEY` | If using Groq | Groq API key |
| `GOOGLE_GENERATIVE_AI_API_KEY` | If using Gemini | Google AI API key |
| `USE_NEW_DISCOVERY` | Yes | Set to `"true"` for v2 mode |
| `REDIS_URL` | No | Redis URL for caching |
| `GITHUB_TOKEN` | No | GitHub token for richer enrichment |

## Tech Stack

- **Framework:** Next.js 15 with App Router
- **Database:** PostgreSQL with Prisma ORM
- **AI:** Groq (LLaMA), Google Gemini
- **Search:** Brave Search API, SearXNG
- **Cache:** Redis (optional)
- **UI:** React 19, Tailwind CSS, Lucide icons

## Who It's For

- **Recruiters & Talent Teams:** Find hard-to-reach professionals faster
- **Founders & Operators:** Identify candidates, advisors, or partners
- **Investors & Researchers:** Discover experts by domain, not just job titles
- **Technical Teams:** Explore engineers, researchers, and builders by real output

## Contributing

Contributions are welcome! Please open an issue or PR.

## License

MIT License

---

<div align="center">

**Signal** by [VantaHire](https://vantahire.com)

</div>
