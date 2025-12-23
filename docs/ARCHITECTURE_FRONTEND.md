# Frontend & UI Architecture

> **Last Updated:** 2025-12-23
> **Framework:** Next.js 15.5.9 + React 19.1.0
> **Status:** Production-ready

## Executive Summary

Signal is a modern Next.js 15 application using the App Router, Clerk authentication, Radix UI primitives, and Tailwind CSS v4. The frontend implements a talent discovery interface with real-time enrichment progress via SSE streams.

**Tech Stack:**
- **Framework:** Next.js 15.5.9 (App Router)
- **React:** 19.1.0
- **Auth:** Clerk (middleware-based protection)
- **Styling:** Tailwind CSS v4 + CSS variables
- **UI Components:** Radix UI + shadcn/ui patterns
- **Animations:** Framer Motion + CSS keyframes
- **Icons:** Lucide React (50+ icons)

---

## Table of Contents

1. [App Structure & Routing](#1-app-structure--routing)
2. [Components Architecture](#2-components-architecture)
3. [State Management](#3-state-management)
4. [API Integration](#4-api-integration)
5. [Styling & Design System](#5-styling--design-system)
6. [Authentication](#6-authentication)
7. [Real-time Features](#7-real-time-features)
8. [Types & Interfaces](#8-types--interfaces)
9. [Key Files](#9-key-files)

---

## 1. App Structure & Routing

### Directory Structure

```
/src
├── app/                          # Next.js App Router
│   ├── layout.tsx                # Root layout (providers, fonts, theme)
│   ├── page.tsx                  # Home page (marketing landing)
│   ├── globals.css               # Global styles + Tailwind config
│   ├── search/
│   │   └── page.tsx              # Search results page
│   ├── enrich/
│   │   └── [candidateId]/
│   │       └── page.tsx          # Enrichment detail page
│   ├── org-selector/
│   │   └── page.tsx              # Organization selection
│   ├── sign-in/
│   │   └── [[...sign-in]]/
│   │       └── page.tsx          # Clerk sign-in
│   ├── sign-up/
│   │   └── [[...sign-up]]/
│   │       └── page.tsx          # Clerk sign-up
│   └── api/                      # API routes
│       └── v2/
│           ├── search/
│           ├── enrich/
│           └── identity/
├── components/                   # React components
│   ├── ui/                       # Primitive UI components
│   │   └── shadcn-io/            # Custom effects
│   ├── SearchBar.tsx
│   ├── Header.tsx
│   ├── Navigation.tsx
│   ├── ProfileSummaryCard.tsx
│   ├── IdentityCandidateCard.tsx
│   ├── CandidateDetails.tsx
│   ├── LoadingState.tsx
│   └── Providers.tsx
├── lib/                          # Utilities & services
│   ├── utils.ts                  # cn() helper
│   ├── rate-limit/               # Rate limiting
│   └── ...                       # Backend services
├── types/                        # TypeScript definitions
│   └── linkedin.ts               # Domain types
└── middleware.ts                 # Auth middleware
```

### Route Map

| Route | Auth | Purpose |
|-------|------|---------|
| `/` | Public | Marketing landing page |
| `/sign-in/*` | Public | Clerk authentication |
| `/sign-up/*` | Public | Clerk registration |
| `/search` | Protected | Search results page |
| `/enrich/[candidateId]` | Protected | Enrichment detail page |
| `/org-selector` | Protected | Organization selection |

### Route Parameters

**Search Page:**
```
/search?q={query}
```

**Enrichment Page:**
```
/enrich/{candidateId}?autostart=1
```
- `candidateId`: UUID from search results
- `autostart=1`: Auto-trigger async enrichment on mount

---

## 2. Components Architecture

### Component Hierarchy

```
RootLayout
├── Providers (Clerk)
│   └── {children}
│
├── HomePage
│   ├── Header
│   ├── AuroraBackground
│   ├── SearchBar
│   └── Feature sections (11)
│
├── SearchPage
│   ├── Header
│   ├── SearchBar
│   ├── Suspense
│   │   └── LoadingState (fallback)
│   └── ProfileSummaryCard[] (grid)
│
├── EnrichmentPage
│   ├── Header
│   ├── CandidateDetails
│   │   ├── AI Summary section
│   │   └── IdentityCandidateCard[] (grouped)
│   └── Status indicators
│
└── OrgSelectorPage
    └── OrganizationList (Clerk)
```

### Component Inventory

#### Layout Components

**Header** (`src/components/Header.tsx`)
```typescript
// Props: None
// Uses: useAuth() from Clerk
// Features:
// - Fixed top navigation
// - Logo link to home
// - Dynamic import for Clerk components
// - Loading placeholders
```

**Navigation** (`src/components/Navigation.tsx`)
```typescript
// Props: None
// Uses: usePathname()
// Features:
// - Fixed floating nav bar
// - Glass effect (backdrop-blur)
// - Active indicator pill
```

**Providers** (`src/components/Providers.tsx`)
```typescript
interface Props {
  children: ReactNode;
}
// Features:
// - Conditional ClerkProvider
// - Graceful degradation without auth keys
```

#### Feature Components

**SearchBar** (`src/components/SearchBar.tsx`)
```typescript
interface SearchBarProps {
  onSearch: (query: string) => void;
  isLoading?: boolean;
  value?: string;              // Controlled mode
  onChange?: (value: string) => void;
  placeholder?: string;
}
// Features:
// - Controlled & uncontrolled modes
// - URL sync via useEffect
// - Form submission handling
// - Search icon (Lucide)
```

**ProfileSummaryCard** (`src/components/ProfileSummaryCard.tsx`)
```typescript
interface ProfileSummaryCardProps {
  summary: ProfileSummaryV2;
}
// Features:
// - Card layout with avatar
// - Name/title, headline, location
// - Snippet preview (line-clamped)
// - Enrich button → opens new tab with ?autostart=1
// - LinkedIn external link
```

**IdentityCandidateCard** (`src/components/IdentityCandidateCard.tsx`)
```typescript
interface IdentityCandidateCardProps {
  identity: IdentityCandidateData;
  onRevealEmail?: (id: string) => Promise<string | null>;
  onConfirm?: (id: string) => Promise<boolean>;
  onReject?: (id: string) => Promise<boolean>;
  showScoreChips?: boolean;    // default: true
}
// State:
// - isRevealing, revealedEmail
// - isConfirming, isRejecting
// Features:
// - Platform icon (20+ platforms)
// - Confidence color coding
// - "Why matched" chips (top 3 signals)
// - Contradiction alerts
// - Evidence display
// - Action buttons (Reveal, Confirm, Reject)
```

**Exported Helpers:**
```typescript
getConfidenceColor(confidence: number): string
getConfidenceBadgeVariant(bucket: string): 'default' | 'secondary' | 'destructive' | 'outline'
getPlatformIcon(platform: string): ReactNode
getPlatformLabel(platform: string): string
getStatusIcon(status: string): ReactNode
```

**CandidateDetails** (`src/components/CandidateDetails.tsx`)
```typescript
interface CandidateDetailsProps {
  candidate: CandidateData;
  identityCandidates: IdentityCandidateData[];
  sessions: EnrichmentSessionSummary[];
  onRevealEmail?: (id: string) => Promise<string | null>;
  onConfirm?: (id: string) => Promise<boolean>;
  onReject?: (id: string) => Promise<boolean>;
}
// Features:
// - Candidate info (LinkedIn ID, name, status)
// - AI summary display
//   - Skills (badges)
//   - Highlights (list)
//   - Talking points (list)
//   - Caveats (warning list)
// - Latest enrichment metadata
// - Identity candidates grouped by status
```

**LoadingState** (`src/components/LoadingState.tsx`)
```typescript
// Props: None
// Features:
// - Grid skeleton loaders (6 items)
// - Pulsing animation
// - Avatar + text skeleton pattern
```

#### UI Primitives (`src/components/ui/`)

| Component | Source | Variants |
|-----------|--------|----------|
| `Button` | CVA | default, destructive, outline, secondary, ghost, link |
| `Card` | Custom | CardHeader, CardTitle, CardDescription, CardContent, CardFooter |
| `Input` | Custom | Standard text input with states |
| `Badge` | CVA | default, secondary, destructive, outline |
| `Avatar` | Radix | AvatarImage, AvatarFallback |
| `Separator` | Radix | Horizontal/vertical |
| `Collapsible` | Radix | CollapsibleTrigger, CollapsibleContent |
| `Skeleton` | Custom | Animated placeholder |
| `NavigationMenu` | Radix | Advanced navigation |

#### Effect Components (`src/components/ui/shadcn-io/`)

**AuroraBackground**
```typescript
interface AuroraBackgroundProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  showRadialGradient?: boolean;
}
// Features:
// - CSS aurora gradient animation
// - 60s animation cycle
// - Background position 50% → 350%
// - Radial gradient mask
```

**Boxes**
```typescript
interface BoxesProps {
  className?: string;
}
// Features:
// - Framer Motion animated grid
// - 150 rows x 100 cols
// - Hover color animation
// - Random color palette (9 colors)
// - SVG grid lines
```

---

## 3. State Management

### Current Approach

**No global state management library** - all state is:
- Component-local (`useState`)
- URL-driven (`useSearchParams`, `usePathname`)
- API response-driven (fetch on mount)

### State Patterns

**URL-Driven State:**
```typescript
// Reading
const searchParams = useSearchParams();
const query = searchParams.get('q');

// Writing
const router = useRouter();
router.push(`/search?q=${encodeURIComponent(query)}`);
```

**Component State Machine (EnrichmentPage):**
```typescript
type EnrichmentState = 'idle' | 'running' | 'completed' | 'failed';

const [status, setStatus] = useState<EnrichmentState>('idle');
const [candidate, setCandidate] = useState<CandidateData | null>(null);
const [identityCandidates, setIdentityCandidates] = useState<IdentityCandidateData[]>([]);
const [session, setSession] = useState<EnrichmentSessionSummary | null>(null);
const [progressEvents, setProgressEvents] = useState<ProgressEvent[]>([]);
```

**Callback Props Pattern:**
```typescript
// Parent provides handlers
<IdentityCandidateCard
  identity={identity}
  onRevealEmail={handleRevealEmail}
  onConfirm={handleConfirm}
  onReject={handleReject}
/>

// Child calls on user action
const handleConfirmClick = async () => {
  setIsConfirming(true);
  const success = await onConfirm?.(identity.id);
  setIsConfirming(false);
};
```

### Installed But Not Used

- **Zustand** (`^5.0.2`) - Available for future use
- **React Query** (`@tanstack/react-query ^5.62.18`) - Available for future use

---

## 4. API Integration

### Fetch Pattern

```typescript
// Standard API call
const response = await fetch('/api/v2/enrich', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ candidateId }),
});

const data = await response.json();
if (!response.ok) {
  throw new Error(data.error || 'Request failed');
}
```

### API Endpoints

| Endpoint | Method | Request | Response |
|----------|--------|---------|----------|
| `/api/v2/search` | POST | `{ query }` | `{ results[], parsedQuery, cached }` |
| `/api/v2/enrich` | GET | `?candidateId=xxx` | `{ candidate, identityCandidates[], sessions[] }` |
| `/api/v2/enrich/async` | POST | `{ candidateId, roleType?, budget? }` | `{ sessionId, jobId, statusUrl }` |
| `/api/v2/enrich/session/stream` | GET | `?sessionId=xxx` | SSE stream |
| `/api/v2/identity/confirm` | POST | `{ identityCandidateId, method }` | `{ summaryRegeneration? }` |
| `/api/v2/identity/confirm` | DELETE | `{ identityCandidateId }` | `{ success }` |
| `/api/v2/identity/reveal` | POST | `{ identityCandidateId }` | `{ email, confidence, source }` |

### Response Format

**Success:**
```typescript
{
  success: true,
  version: 'v2',
  // payload fields...
  timestamp: number,
  cached?: boolean,
  provider?: string,
}
```

**Error:**
```typescript
{
  success: false,
  error: string,
  status?: number,
  details?: object,
}
```

### Data Flow Examples

**Search Flow:**
```
SearchBar → onSearch(query)
  → router.push('/search?q=...')
  → SearchPage reads searchParams
  → fetch POST /api/v2/search
  → setResults(data.results)
  → ProfileSummaryCard[] rendered
```

**Enrichment Flow:**
```
ProfileSummaryCard → "Enrich" button
  → window.open('/enrich/{id}?autostart=1')
  → EnrichmentPage mounts
  → fetch GET /api/v2/enrich?candidateId=...
  → if autostart: POST /api/v2/enrich/async
  → subscribe to SSE stream
  → progressEvents update UI
  → on complete: re-fetch candidate data
```

**Identity Confirmation Flow:**
```
IdentityCandidateCard → "Confirm" button
  → onConfirm(id) callback
  → POST /api/v2/identity/confirm
  → if summaryRegeneration.triggered:
      → subscribe to summary stream
      → update summary on complete
  → refresh identity list
```

---

## 5. Styling & Design System

### Tailwind Configuration

**Version:** Tailwind CSS v4
**PostCSS:** `@tailwindcss/postcss`
**Config:** Inline in `globals.css`

### Color System

**CSS Variables (Dark Theme):**
```css
:root.dark {
  /* Background */
  --background: #0D0D1A;        /* Deep dark blue-black */
  --foreground: #FFFFFF;
  --card: #141428;              /* Slightly lighter */
  --card-foreground: #FFFFFF;

  /* Brand Colors */
  --primary: #8B5CF6;           /* Purple */
  --primary-foreground: #FFFFFF;
  --accent: #FBBF24;            /* Gold */
  --accent-foreground: #0D0D1A;

  /* Semantic */
  --secondary: #1E1E3F;         /* Dark blue */
  --muted: #1E1E3F;
  --muted-foreground: #A1A1AA;
  --destructive: #EF4444;       /* Red */

  /* Borders & Inputs */
  --border: rgba(139, 92, 246, 0.2);    /* Purple transparent */
  --input: rgba(139, 92, 246, 0.15);
  --ring: #8B5CF6;

  /* Charts */
  --chart-1: #8B5CF6;           /* Purple */
  --chart-2: #A78BFA;           /* Light purple */
  --chart-3: #FBBF24;           /* Gold */
  --chart-4: #F59E0B;           /* Orange gold */
  --chart-5: #7C3AED;           /* Deep purple */
}
```

**Brand Palette:**
| Name | Hex | Usage |
|------|-----|-------|
| Purple | `#8B5CF6` | Primary actions, links |
| Light Purple | `#A78BFA` | Hover states, accents |
| Gold | `#FBBF24` | CTA buttons, highlights |
| Orange Gold | `#F59E0B` | Secondary accent |
| Deep Purple | `#7C3AED` | Depth, shadows |

### Typography

**Fonts:**
```css
--font-outfit: 'Outfit', sans-serif;     /* 300-800 weights */
--font-space-mono: 'Space Mono', monospace;  /* 400, 700 */
```

**Custom Classes:**
```css
/* Gradient Text */
.gradient-text-purple {
  background: linear-gradient(135deg, #A78BFA, #8B5CF6);
  -webkit-background-clip: text;
  color: transparent;
}

.gradient-text-gold {
  background: linear-gradient(135deg, #FBBF24, #F59E0B);
  -webkit-background-clip: text;
  color: transparent;
}

.gradient-text-mixed {
  background: linear-gradient(135deg, #A78BFA, #FBBF24);
  -webkit-background-clip: text;
  color: transparent;
}

/* Stats Numbers */
.stat-number {
  font-family: var(--font-space-mono);
  background: linear-gradient(135deg, #8B5CF6, #FBBF24);
  -webkit-background-clip: text;
  color: transparent;
}
```

### Animations

**Keyframes:**
```css
@keyframes aurora {
  from { background-position: 50% 50%, 50% 50%; }
  to { background-position: 350% 50%, 350% 50%; }
}

@keyframes moveHorizontal {
  0% { transform: translateX(-50%) translateY(-10%); }
  50% { transform: translateX(50%) translateY(10%); }
  100% { transform: translateX(-50%) translateY(-10%); }
}

@keyframes moveInCircle {
  0% { transform: rotate(0deg); }
  50% { transform: rotate(180deg); }
  100% { transform: rotate(360deg); }
}

@keyframes moveVertical {
  0% { transform: translateY(-50%); }
  50% { transform: translateY(50%); }
  100% { transform: translateY(-50%); }
}
```

**Animation Classes:**
```css
.animate-first  { animation: moveVertical 30s ease infinite; }
.animate-second { animation: moveInCircle 20s reverse infinite; }
.animate-third  { animation: moveInCircle 40s linear infinite; }
.animate-fourth { animation: moveHorizontal 40s ease infinite; }
.animate-fifth  { animation: moveInCircle 20s ease infinite; }
```

### Utility: `cn()`

```typescript
// src/lib/utils.ts
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
```

Usage:
```tsx
<div className={cn(
  'base-class',
  isActive && 'active-class',
  variant === 'primary' ? 'primary-class' : 'secondary-class'
)} />
```

### Responsive Design

**Breakpoints:**
| Prefix | Min Width |
|--------|-----------|
| `sm:` | 640px |
| `md:` | 768px |
| `lg:` | 1024px |
| `xl:` | 1280px |
| `2xl:` | 1536px |

**Common Patterns:**
```tsx
// Grid columns
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">

// Flex direction
<div className="flex flex-col md:flex-row items-center gap-4">

// Text sizing
<h1 className="text-3xl md:text-4xl lg:text-5xl font-bold">
```

---

## 6. Authentication

### Clerk Integration

**Provider Setup:**
```typescript
// src/components/Providers.tsx
export function Providers({ children }: { children: ReactNode }) {
  if (!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) {
    return <>{children}</>;  // Graceful degradation
  }
  return <ClerkProvider>{children}</ClerkProvider>;
}
```

**Middleware Protection:**
```typescript
// src/middleware.ts
import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';

const isPublicRoute = createRouteMatcher([
  '/',
  '/sign-in(.*)',
  '/sign-up(.*)',
  '/api/health',
]);

export default clerkMiddleware((auth, req) => {
  const { userId, orgId } = auth();

  // Protected routes require auth
  if (!isPublicRoute(req) && !userId) {
    return auth().redirectToSignIn({
      returnBackUrl: req.url,
    });
  }

  // Some routes require organization
  if (isOrgRequired(req) && !orgId) {
    return NextResponse.redirect(new URL('/org-selector', req.url));
  }
});
```

**Using Auth in Components:**
```typescript
import { useAuth } from '@clerk/nextjs';

function Header() {
  const { userId, orgId } = useAuth();

  if (!userId) {
    return <SignInButton />;
  }

  return (
    <>
      <UserButton />
      <OrganizationSwitcher />
    </>
  );
}
```

**Dynamic Imports (SSR-safe):**
```typescript
const UserButton = dynamic(
  () => import('@clerk/nextjs').then((mod) => mod.UserButton),
  { ssr: false, loading: () => <Skeleton className="h-8 w-8 rounded-full" /> }
);

const OrganizationSwitcher = dynamic(
  () => import('@clerk/nextjs').then((mod) => mod.OrganizationSwitcher),
  { ssr: false, loading: () => <Skeleton className="h-8 w-32" /> }
);
```

### Route Protection Summary

| Route Pattern | Auth | Org | Role |
|---------------|------|-----|------|
| `/` | No | No | - |
| `/sign-in/*` | No | No | - |
| `/sign-up/*` | No | No | - |
| `/search/*` | Yes | Yes | recruiter |
| `/enrich/*` | Yes | Yes | recruiter |
| `/org-selector` | Yes | No | - |
| `/api/v2/search` | Yes | Yes | recruiter |
| `/api/v2/enrich/*` | Yes | Yes | recruiter |
| `/api/v2/identity/*` | Yes | Yes | recruiter |

---

## 7. Real-time Features

### Server-Sent Events (SSE)

**Endpoint:** `GET /api/v2/enrich/session/stream?sessionId=xxx`

**Event Types:**
```typescript
interface ProgressEvent {
  type: 'connected' | 'progress' | 'completed' | 'failed' | 'timeout';
  node?: string;           // LangGraph node name
  data?: {
    platform?: string;
    identitiesFound?: number;
    queriesExecuted?: number;
    confidence?: number;
    error?: string;
  };
  timestamp: string;
}
```

**Client Implementation:**
```typescript
useEffect(() => {
  if (!sessionId || status !== 'running') return;

  const eventSource = new EventSource(
    `/api/v2/enrich/session/stream?sessionId=${sessionId}`
  );

  eventSource.addEventListener('connected', (e) => {
    console.log('SSE connected');
  });

  eventSource.addEventListener('progress', (e) => {
    const event = JSON.parse(e.data);
    setProgressEvents(prev => [...prev, event]);
  });

  eventSource.addEventListener('completed', (e) => {
    const event = JSON.parse(e.data);
    setStatus('completed');
    fetchCandidate();  // Refresh data
    eventSource.close();
  });

  eventSource.addEventListener('failed', (e) => {
    const event = JSON.parse(e.data);
    setStatus('failed');
    setError(event.data?.error || 'Enrichment failed');
    eventSource.close();
  });

  eventSource.addEventListener('timeout', () => {
    // Fallback: poll for status
    fetchCandidate();
    eventSource.close();
  });

  return () => eventSource.close();
}, [sessionId, status]);
```

**Server Implementation:**
```typescript
// In API route
export async function GET(request: Request) {
  const sessionId = new URL(request.url).searchParams.get('sessionId');

  const stream = new ReadableStream({
    start(controller) {
      // Send connected event
      controller.enqueue(`event: connected\ndata: ${JSON.stringify({ timestamp: new Date().toISOString() })}\n\n`);

      // Subscribe to job events
      const queueEvents = getQueueEvents();

      queueEvents.on('progress', ({ jobId, data }) => {
        if (jobId === sessionId) {
          controller.enqueue(`event: progress\ndata: ${JSON.stringify(data)}\n\n`);
        }
      });

      queueEvents.on('completed', ({ jobId, returnvalue }) => {
        if (jobId === sessionId) {
          controller.enqueue(`event: completed\ndata: ${JSON.stringify(returnvalue)}\n\n`);
          controller.close();
        }
      });

      // Timeout fallback
      setTimeout(() => {
        controller.enqueue(`event: timeout\ndata: {}\n\n`);
        controller.close();
      }, 60000);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
```

### Progress Display

```tsx
// EnrichmentPage
{status === 'running' && (
  <div className="space-y-2">
    <div className="flex items-center gap-2">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span>Enrichment in progress...</span>
    </div>
    <div className="text-sm text-muted-foreground">
      {progressEvents.map((event, i) => (
        <div key={i}>
          {event.node}: {event.data?.platform || 'processing'}
        </div>
      ))}
    </div>
  </div>
)}
```

---

## 8. Types & Interfaces

### Core Domain Types

```typescript
// src/types/linkedin.ts

// Role type for enrichment prioritization
type RoleType =
  | 'engineer'
  | 'data_scientist'
  | 'researcher'
  | 'founder'
  | 'designer'
  | 'general';

// Search result with candidate ID
interface ProfileSummaryV2 extends ProfileSummary {
  candidateId: string | null;
}

interface ProfileSummary {
  name: string;
  headline: string;
  location: string;
  snippet: string;
  linkedinUrl: string;
}

// Identity candidate from enrichment
interface IdentityCandidateData {
  id: string;
  platform: string;                    // 'github', 'stackoverflow', etc.
  platformId: string;
  profileUrl: string;
  confidence: number;                  // 0-1
  confidenceBucket: string | null;     // 'auto_merge' | 'suggest' | 'low' | 'rejected'
  scoreBreakdown: Record<string, number> | null;
  hasContradiction: boolean;
  contradictionNote: string | null;
  status: 'unconfirmed' | 'confirmed' | 'rejected';
  evidence?: CommitEmailEvidence[];
  createdAt: string;
  updatedAt?: string;
}

// Candidate from database
interface CandidateData {
  id: string;
  linkedinId: string;
  linkedinUrl: string;
  nameHint: string | null;
  headlineHint?: string | null;
  locationHint?: string | null;
  enrichmentStatus: string;
  confidenceScore: number | null;
  lastEnrichedAt: string | null;
}

// AI-generated summary
interface AISummaryStructured {
  skills?: string[];
  highlights?: string[];
  talkingPoints?: string[];
  caveats?: string[];
  confidence?: number;
}

// Enrichment session
interface EnrichmentSessionSummary {
  id: string;
  status: string;                      // 'running', 'completed', 'failed'
  sourcesExecuted: string[] | null;
  queriesExecuted: number | null;
  identitiesFound: number;
  finalConfidence: number | null;
  durationMs: number | null;
  createdAt: string;
  completedAt: string | null;
  summary?: string | null;
  summaryStructured?: AISummaryStructured | null;
  summaryModel?: string | null;
  summaryGeneratedAt?: string | null;
  runTrace?: {
    final?: {
      summaryMeta?: {
        mode?: 'draft' | 'verified';
        confirmedCount?: number;
        identityKey?: string;
      };
    };
  } | null;
}

// Commit email evidence
interface CommitEmailEvidence {
  type: 'commit_email';
  repoFullName: string;
  commitSha: string;
  commitUrl: string;
  authorName: string;
}
```

### Platform Types

```typescript
type EnrichmentPlatform =
  | 'github'
  | 'stackoverflow'
  | 'npm'
  | 'pypi'
  | 'docker'
  | 'kaggle'
  | 'orcid'
  | 'scholar'
  | 'medium'
  | 'twitter'
  | 'youtube'
  | 'dribbble'
  | 'behance'
  | 'huggingface'
  | 'devto'
  | 'gitlab'
  | 'leetcode'
  | 'hackerearth'
  | 'codepen'
  | 'researchgate'
  | 'arxiv'
  | 'patents'
  | 'sec'
  | 'crunchbase'
  | 'angellist'
  | 'substack'
  | 'university'
  | 'companyteam';
```

---

## 9. Key Files

### Pages

| File | Purpose |
|------|---------|
| `src/app/layout.tsx` | Root layout, fonts, providers |
| `src/app/page.tsx` | Home/marketing page |
| `src/app/search/page.tsx` | Search results |
| `src/app/enrich/[candidateId]/page.tsx` | Enrichment detail |
| `src/app/org-selector/page.tsx` | Organization selection |
| `src/app/globals.css` | Global styles, Tailwind config |

### Components

| File | Lines | Purpose |
|------|-------|---------|
| `src/components/SearchBar.tsx` | 68 | Search input with submission |
| `src/components/Header.tsx` | 97 | Top navigation |
| `src/components/Navigation.tsx` | 80 | Floating nav bar |
| `src/components/ProfileSummaryCard.tsx` | 82 | Search result card |
| `src/components/IdentityCandidateCard.tsx` | 375 | Identity display + actions |
| `src/components/CandidateDetails.tsx` | 283 | Full candidate view |
| `src/components/LoadingState.tsx` | 27 | Skeleton loaders |
| `src/components/Providers.tsx` | 26 | Auth provider wrapper |

### UI Primitives

| File | Source |
|------|--------|
| `src/components/ui/button.tsx` | CVA + Radix Slot |
| `src/components/ui/card.tsx` | Custom |
| `src/components/ui/input.tsx` | Custom |
| `src/components/ui/badge.tsx` | CVA |
| `src/components/ui/avatar.tsx` | Radix Avatar |
| `src/components/ui/skeleton.tsx` | Custom |
| `src/components/ui/separator.tsx` | Radix Separator |
| `src/components/ui/collapsible.tsx` | Radix Collapsible |

### Effects

| File | Purpose |
|------|---------|
| `src/components/ui/shadcn-io/aurora-background/` | Aurora gradient animation |
| `src/components/ui/shadcn-io/background-boxes/` | Animated grid boxes |

### Utilities

| File | Purpose |
|------|---------|
| `src/lib/utils.ts` | `cn()` class merger |
| `src/middleware.ts` | Auth middleware |
| `src/types/linkedin.ts` | Domain types |

---

## Appendix: Icon Reference

### Lucide Icons Used

**Navigation & Actions:**
```
Search, Home, ArrowRight, ExternalLink, Play, RefreshCw
```

**Status & Feedback:**
```
CheckCircle, CheckCircle2, XCircle, AlertCircle, AlertTriangle,
Loader2, Clock, Sparkles
```

**Platforms:**
```
Github, Code, Code2, FileText, Package, Database, Briefcase,
Building2, GraduationCap, Video, Twitter, Palette, Brush,
FlaskConical, Mail, MessageSquare, PenLine
```

**Features:**
```
Zap, Brain, Globe, Shield, Users, Rocket, TrendingUp, Puzzle,
BookOpen, Award, Lightbulb
```

### Platform Icon Mapping

```typescript
const platformIcons: Record<string, ReactNode> = {
  github: <Github className="h-4 w-4" />,
  stackoverflow: <Code className="h-4 w-4" />,
  npm: <Package className="h-4 w-4" />,
  pypi: <Package className="h-4 w-4" />,
  docker: <Database className="h-4 w-4" />,
  kaggle: <FlaskConical className="h-4 w-4" />,
  medium: <PenLine className="h-4 w-4" />,
  twitter: <Twitter className="h-4 w-4" />,
  youtube: <Video className="h-4 w-4" />,
  dribbble: <Palette className="h-4 w-4" />,
  behance: <Brush className="h-4 w-4" />,
  // ... more mappings
};
```

---

## Appendix: Future Considerations

### Current Limitations

1. **No global state** - All state is component-local or URL-driven
2. **No React Query** - Manual fetch with no automatic caching/refetching
3. **No custom hooks** - Repeated patterns could be abstracted
4. **No error boundary** - Unhandled errors may crash the app
5. **No form library** - Simple forms only
6. **No E2E tests** - Manual testing only

### Scaling Recommendations

1. **Add Zustand** for shared UI state (theme, sidebar, modals)
2. **Add React Query** for server state with automatic cache invalidation
3. **Extract custom hooks:**
   - `useEnrichment(candidateId)` - fetch + subscribe
   - `useIdentityActions()` - confirm/reject/reveal
   - `useSearch()` - search with debounce
4. **Add error boundary** with fallback UI
5. **Add Storybook** for component development
6. **Add Playwright** for E2E testing

### Three.js Integration (Future)

Packages installed but not used:
- `@react-three/fiber` ^9.3.0
- `@react-three/drei` ^10.7.6
- `three` ^0.180.0

Potential use cases:
- 3D identity graph visualization
- Interactive platform connections
- Animated data flow diagrams
