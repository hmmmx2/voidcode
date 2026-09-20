# VoidCode AI v5.3 — Complete Project Documentation

> **NOT CURRENT — see `desktop/docs/DECISIONS.md` § "Known-stale documents".** This predates the
> desktop application: the product is an Electron app now, the website is a handful of static pages
> that hold no session, and identity is a bearer token rather than a signed header. The subsystem
> detail below is still the best description of those parts that exists, which is why the file is
> kept — but the architecture it draws is not the one that ships. `README.md` and `AGENTS.md` are
> the current shape of the tree.

> **Last updated**: 2026-03-12
> **Purpose**: Full implementation record — every file, every decision, every setup step.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Repository Structure](#2-repository-structure)
3. [Tech Stack](#3-tech-stack)
4. [Environment & Prerequisites](#4-environment--prerequisites)
5. [Setup & Installation](#5-setup--installation)
6. [Frontend — Next.js 16 (`apps/web`)](#6-frontend--nextjs-16-appsweb)
7. [Backend — FastAPI (`apps/api`)](#7-backend--fastapi-appsapi)
8. [LLM Training Pipeline (`llm/`)](#8-llm-training-pipeline-llm)
9. [Shared Types (`packages/shared`)](#9-shared-types-packagesshared)
10. [Docker Infrastructure](#10-docker-infrastructure)
11. [Database Schema](#11-database-schema)
12. [API Endpoints Reference](#12-api-endpoints-reference)
13. [Authentication Flow](#13-authentication-flow)
14. [VoidCode AI Mode System](#14-voidcode-ai-mode-system)
15. [Training Pipeline Workflow](#15-training-pipeline-workflow)
16. [Model Inference Architecture](#16-model-inference-architecture)
17. [Evaluation Suite](#17-evaluation-suite)
18. [Tunnel & Remote Access](#18-tunnel--remote-access)
19. [Gotchas & Lessons Learned](#19-gotchas--lessons-learned)
20. [File Inventory](#20-file-inventory)

---

## 1. Project Overview

VoidCode AI is a **fine-tuning research initiative** that trains **Qwen 2.5 7B** with **QLoRA** for Socratic teaching behaviour in programming education. The platform provides:

- A **LeetCode-style workspace** with Monaco code editor, test runner (Judge0), and submission tracking
- An **VoidCode AIing chatbot** that uses 5 response modes + an EMPATHY override based on query type
- A **course management system** with modules, content items, and progress tracking
- A **user profile system** with OAuth (Google + Microsoft Entra ID), avatar cropping, and preferences

The model never gives direct answers — it uses Socratic questioning, code templates with blanks (`____`), and guided debugging to help students learn.

---

## 2. Repository Structure

```
voidcode_ai/
├── apps/
│   ├── web/                          # Next.js 16 frontend
│   │   ├── src/
│   │   │   ├── app/                  # Pages & routes (App Router)
│   │   │   ├── components/           # React components
│   │   │   ├── lib/                  # Utilities, hooks, API clients
│   │   │   ├── auth.ts              # NextAuth configuration
│   │   │   ├── auth.d.ts            # Auth type extensions
│   │   │   └── middleware.ts        # Route protection
│   │   ├── public/icons/             # SVG icon assets
│   │   ├── next.config.ts
│   │   ├── tailwind.config.ts
│   │   ├── postcss.config.mjs
│   │   ├── eslint.config.mjs
│   │   ├── tsconfig.json
│   │   └── package.json
│   │
│   └── api/                          # FastAPI backend
│       ├── src/
│       │   ├── main.py              # FastAPI app, mode routing, streaming
│       │   ├── vllm_engine.py       # vLLM AsyncLLMEngine wrapper + SSE
│       │   ├── database.py          # SQLAlchemy async engine
│       │   ├── redis_client.py      # Redis connection manager
│       │   ├── models/              # SQLAlchemy ORM models (8 files)
│       │   ├── routers/             # API route handlers (9 files)
│       │   ├── schemas/             # Pydantic request/response (4 files)
│       │   └── services/            # Business logic layer (6 files)
│       ├── alembic/                  # Database migrations (7 versions)
│       ├── scripts/                  # Offline utilities (merge, quantize, seed)
│       ├── Dockerfile               # CPU inference image
│       ├── Dockerfile.gpu           # GPU vLLM inference image
│       ├── requirements.txt         # CPU dependencies
│       ├── requirements.gpu.txt     # GPU dependencies
│       ├── .env.example             # Local dev env template
│       └── .env.docker.example      # Docker env template
│
├── llm/                              # Fine-tuning & training pipeline
│   ├── scripts/                      # Training scripts (9 files)
│   ├── data/                         # JSONL training & eval data
│   ├── outputs/                      # Model artifacts
│   │   ├── final_model/             # LoRA adapter (~100 MB)
│   │   ├── merged_model/           # Base + LoRA merged fp16 (~14 GB)
│   │   └── awq_model/              # W4A16 quantized (~5.26 GiB)
│   └── configs/
│       └── training_config.yaml
│
├── packages/
│   └── shared/                       # Shared TypeScript types
│       ├── src/types/               # api.ts, chat.ts, user.ts
│       ├── tsconfig.json
│       └── package.json
│
├── docker-compose.yml                # Base: Postgres, Redis, Judge0
├── docker-compose.dev.yml            # Dev: live source mounts
├── docker-compose.gpu.yml            # GPU: vLLM API service
├── docker-compose.prod.yml           # Prod: 3 GPU replicas + Nginx LB
├── nginx.conf                        # Reverse proxy / load balancer
├── turbo.json                        # Turborepo pipeline config
├── pnpm-workspace.yaml               # pnpm workspace definition
├── pnpm-lock.yaml                    # Lockfile
├── package.json                      # Root monorepo package
├── tunnel-config.yml                 # Cloudflare Tunnel config
├── start-tunnels.bat                 # Tunnel launch script (Windows)
│
├── AGENTS.md                         # Agent brief for this repository
├── ARCHITECTURE.md                   # Architecture overview
├── DOCKER_GPU_INFERENCE.md           # GPU Docker setup guide
├── ENGINEERING_RECOMMENDATION.md     # Engineering decisions
├── FUTURE_IMPLEMENTATION.md          # Roadmap / future work
├── LLM_ARCHITECTURE.md              # LLM architecture details
├── MODEL_IMPROVEMENT_PROMPT.md       # Model improvement strategies
├── PHASE_CHECKLIST.md               # Phase implementation checklist
├── TUNNEL_SETUP.md                  # Tunnel setup instructions
├── UNIVERSITY_INFRA_SPEC.md         # University infrastructure spec
└── README.md                        # Project readme
```

---

## 3. Tech Stack

### Frontend
| Technology | Version | Purpose |
|---|---|---|
| Next.js | 16 | React framework (App Router) |
| React | 19 | UI library |
| TypeScript | 5.x | Type safety |
| Tailwind CSS | v4 | Utility-first CSS |
| Monaco Editor | latest | Code editor (VS Code engine) |
| NextAuth | v5 beta | OAuth authentication |
| pnpm | 9.0.0 | Package manager |
| Turborepo | 2.x | Monorepo build orchestration |

### Backend
| Technology | Version | Purpose |
|---|---|---|
| FastAPI | 0.129.0 | Python web framework |
| Uvicorn | latest | ASGI server |
| SQLAlchemy | 2.x (async) | ORM + database toolkit |
| asyncpg | latest | Async PostgreSQL driver |
| Alembic | latest | Database migrations |
| Redis | 7 (aioredis) | Caching + pub/sub notifications |
| Pydantic | 2.x | Request/response validation |
| httpx | latest | Async HTTP client (Judge0) |

### Infrastructure
| Technology | Version | Purpose |
|---|---|---|
| PostgreSQL | 16 | Primary database |
| Redis | 7 | Cache + real-time events |
| Judge0 CE | 1.13.1 | Code execution sandbox |
| Docker + Compose | latest | Containerization |
| Nginx | latest | Reverse proxy / load balancer |
| Cloudflare Tunnel | latest | Remote access (free tier) |

### ML / Training
| Technology | Version | Purpose |
|---|---|---|
| PyTorch | ≥2.2.0 (GPU: 2.9.1+cu128) | Deep learning framework |
| Transformers | ≥4.36.0 (GPU: 4.57.6) | Model loading + tokenization |
| PEFT | latest | LoRA adapter management |
| TRL | latest | SFTTrainer for fine-tuning |
| BitsAndBytes | latest | 4-bit NF4 quantization |
| vLLM | 0.15.1 | Production inference engine |
| llmcompressor | latest | AWQ quantization (W4A16) |
| Triton | 3.5.1 | CUDA kernels for PagedAttention |

### Base Model
| Property | Value |
|---|---|
| Model | Qwen/Qwen2.5-7B-Instruct |
| Parameters | 7 billion |
| Fine-tuning | QLoRA (4-bit NF4, bfloat16 compute) |
| LoRA Config | rank=16, alpha=32, 7 target modules |
| Training Data | 1,850 examples (v5.3) |
| Quantized Size | ~5.26 GiB (W4A16 AWQ) |

---

## 4. Environment & Prerequisites

### Hardware Requirements
- **GPU**: NVIDIA with 16GB+ VRAM (RTX 5060 Ti or better)
- **RAM**: 16GB+ system memory
- **Storage**: 30GB+ free space (model artifacts)
- **CUDA**: 12.1+ (GPU: 12.8 for Blackwell sm_120 support)
- **PyTorch**: 2.1+ (GPU: 2.9.1+cu128)

### Software Requirements
- **OS**: Windows 11 (development), Ubuntu 24.04 (Docker containers)
- **WSL2**: Required for vLLM inference path on Windows
- **Node.js**: 18+ (for Next.js 16)
- **pnpm**: 9.0.0+
- **Python**: 3.12+
- **Docker**: Latest with Compose V2
- **NVIDIA Container Toolkit**: For GPU passthrough to Docker

### Accounts / Credentials
- **Google OAuth**: Client ID + Secret for Google sign-in
- **Microsoft Entra ID**: Client ID + Secret + Tenant ID for Microsoft sign-in
- **HuggingFace**: Account for downloading Qwen 2.5 7B base model (first time only)

---

## 5. Setup & Installation

### 5.1 Clone & Install Dependencies

```bash
# Clone the repository
git clone <repo-url> voidcode_ai
cd voidcode_ai

# Install all workspace dependencies (frontend + shared types)
pnpm install
```

### 5.2 Environment Files

#### Frontend (`apps/web/.env.local`)
```env
# API URL — local dev or tunnel URL
NEXT_PUBLIC_API_URL=http://localhost:8000

# NextAuth
AUTH_SECRET=<64-char-hex-token>
AUTH_URL=http://localhost:3000

# Google OAuth
AUTH_GOOGLE_ID=<google-client-id>
AUTH_GOOGLE_SECRET=<google-client-secret>

# Microsoft Entra ID
AUTH_MICROSOFT_ENTRA_ID_ID=<ms-client-id>
AUTH_MICROSOFT_ENTRA_ID_SECRET=<ms-client-secret>
AUTH_MICROSOFT_ENTRA_ID_TENANT_ID=<tenant-id-or-common>
```

#### Backend — Local Dev (`apps/api/.env`)
```env
# Database (host-exposed ports from docker-compose.yml)
DATABASE_URL=postgresql+asyncpg://voidcode:voidcode_pass@localhost:5433/voidcode_ai

# Redis (host-exposed port)
REDIS_URL=redis://localhost:6380/0

# Judge0 (host-exposed port)
# NOTE: From WSL2, use Windows IP from /etc/resolv.conf instead of localhost
JUDGE0_BASE_URL=http://localhost:2358

# Model (local HuggingFace inference, no vLLM)
USE_VLLM=false
MODEL_PATH=./llm/outputs/final_model
BASE_MODEL=Qwen/Qwen2.5-7B-Instruct

# Security
SECRET_KEY=<64-char-hex-token>

# Concurrency
MAX_CONCURRENT_REQUESTS=2
```

#### Backend — Docker GPU (`apps/api/.env.docker`)
```env
# Database (Docker internal service names, internal ports)
DATABASE_URL=postgresql+asyncpg://voidcode:voidcode_pass@postgres:5432/voidcode_ai

# Redis (Docker internal)
REDIS_URL=redis://redis:6379/0

# Judge0 (Docker internal)
JUDGE0_BASE_URL=http://judge0-server:2358

# Model (vLLM with AWQ quantized model)
USE_VLLM=true
MODEL_PATH=/models/awq_model
GPU_MEMORY_UTILIZATION=0.90
MAX_MODEL_LEN=8192

# Security
SECRET_KEY=<64-char-hex-token>
NEXTAUTH_SECRET=<64-char-hex-token>

# Concurrency
MAX_CONCURRENT_REQUESTS=8
```

> **Critical difference**: Local dev uses host-exposed ports (`localhost:5433`, `localhost:6380`). Docker uses internal service names and ports (`postgres:5432`, `redis:6379`).

### 5.3 Start Infrastructure (Database, Redis, Judge0)

```bash
# Start Postgres, Redis, and Judge0 (no API)
docker compose up -d

# Verify services are running
docker compose ps
```

**Port mapping**:
| Service | Internal Port | Host Port |
|---|---|---|
| PostgreSQL | 5432 | 5433 |
| Redis | 6379 | 6380 |
| Judge0 | 2358 | 2358 |

### 5.4 Run Database Migrations

```bash
cd apps/api

# Run all Alembic migrations
alembic upgrade head

# Seed problem data
python -m scripts.seed_problems

# Seed course/curriculum data
python -m scripts.seed_courses
```

**Migration history** (7 versions):
1. `ac9a1b3b96f9` — Initial schema (users, problems, test_cases, code_templates, submissions, test_case_results, chat_sessions, chat_messages)
2. `3ac4f79184db` — Add courses table
3. `9024b6255687` — Add driver_code to code_templates
4. `93f288d0e905` — Add code_drafts table
5. `a7b2c3d4e5f6` — Add modules and content_items tables
6. `c3f7a8d91e02` — Add profile fields and notifications table
7. `f43c1af6356d` — Add timezone to users

### 5.5 Start Backend (Local Dev — No GPU)

```bash
cd apps/api

# Install Python dependencies
pip install -r requirements.txt

# Start FastAPI server
uvicorn src.main:app --host 0.0.0.0 --port 8000 --reload
```

### 5.6 Start Frontend

```bash
# From project root
pnpm dev:web
# or: cd apps/web && pnpm dev

# Opens at http://localhost:3000
```

### 5.7 Start Backend (Docker GPU — Production)

```bash
# Build and start everything including GPU vLLM API
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d

# Watch for "Application startup complete." in vLLM logs
docker logs -f voidcode-vllm-api

# Health check
curl http://localhost:8000/health
```

### 5.8 Start Backend (Docker GPU — Development with live mounts)

```bash
# Dev mode: source code mounted into container, edit .py files locally
docker compose \
  -f docker-compose.yml \
  -f docker-compose.gpu.yml \
  -f docker-compose.dev.yml \
  up -d

# After editing Python files, restart the API container (~40s warm start)
docker restart voidcode-vllm-api
```

### 5.9 Build for Production

```bash
# Build shared types + frontend
pnpm install
npx turbo build --filter=@voidcode/web

# Multi-GPU production (3 replicas + Nginx load balancer)
docker compose \
  -f docker-compose.yml \
  -f docker-compose.gpu.yml \
  -f docker-compose.prod.yml \
  up -d
```

---

## 6. Frontend — Next.js 16 (`apps/web`)

### 6.1 Route Structure

```
(root)
├── /                           → Redirect to /homepage (authenticated) or /login
├── /login                      → OAuth login page (Google + Microsoft)
├── /api/auth/[...nextauth]     → NextAuth API route handler
│
├── (homepage) layout            → Homepage layout with TopNavigation
│   ├── /homepage               → Dashboard with progress + course cards
│   ├── /courses                → Course catalogue with search
│   ├── /courses/[code]         → Course detail with module accordion
│   ├── /privacy                → Privacy policy page
│   └── /terms                  → Terms of service page
│
├── (profile) layout             → Profile layout with sidebar
│   ├── /profile                → User profile with avatar cropper
│   ├── /privacy                → Privacy policy (profile context)
│   └── /terms                  → Terms of service (profile context)
│
└── (workspace) layout           → 3-column workspace layout
    └── /problems/[id]          → Problem editor page (Monaco + VoidCode AI)
```

### 6.2 Component Inventory

#### Layout Components
| Component | File | Purpose |
|---|---|---|
| `TopNavigation` | `Layout/TopNavigation.tsx` | Header with logo, nav links, problem navigator, search, user menu. Three variants: "workspace", "profile", "homepage". Scroll-driven transparency. |
| `ResizableLayout` | `Layout/ResizableLayout.tsx` | 3-column layout with drag-to-resize. Left (problem), middle (code + tests), right (VoidCode AI). Middle has vertical split for editor/console. Supports editor expansion mode. |
| `WorkspaceClient` | `Layout/WorkspaceClient.tsx` | Orchestrates workspace state: problem data, code, language, execution/submission state, draft autosave, VoidCode AI context. |
| `AppFooter` | `Layout/AppFooter.tsx` | Page footer. |
| `NotificationBell` | `Layout/NotificationBell.tsx` | Notification icon with unread badge count. |

#### VoidCode AI Components
| Component | File | Purpose |
|---|---|---|
| `VoidCodeAIPanel` | `VoidCodeAI/VoidCodeAIPanel.tsx` | Main chat panel. Session management (create/list/select/delete). Mode detection based on problem context + submission results. SSE streaming for live responses. Passes `VoidCodeAIContext` including problem, code, execution state. |
| `ChatMessage` | `VoidCodeAI/ChatMessage.tsx` | Message bubble with markdown rendering. User messages right-aligned (dark), assistant left-aligned (darker). Renders headings, lists, bold, italic, code blocks, inline code. Conditionally shows `ThinkingBlock`. |
| `ThinkingBlock` | `VoidCodeAI/ThinkingBlock.tsx` | Expandable block showing model's internal reasoning. Token budget progress bar (green/yellow/red). Displays prompt/completion/total token counts. |
| `ChatHistoryDropdown` | `VoidCodeAI/ChatHistoryDropdown.tsx` | Session list dropdown with title, timestamp, message count. Hover-to-reveal delete button. Click-outside-to-close. Active session highlighting. |
| `ReviewTemplateBlock` | `VoidCodeAI/ReviewTemplateBlock.tsx` | Review/template UI for code reviews. |

#### Editor Components
| Component | File | Purpose |
|---|---|---|
| `CodeColumn` | `Editor/CodeColumn.tsx` | Code editor wrapper. Language dropdown (Python/JS/C++/Java). Run/Submit buttons. Reset/Expand toggles. Save status indicator ("Saving..." / "Saved" / "Save failed"). |
| `MonacoWrapper` | `Editor/MonacoWrapper.tsx` | Monaco Editor with dynamic import (SSR disabled). Dark theme (vs-dark), JetBrains Mono font, 14px, minimap off. Controlled component (value + onChange). |
| `TestConsole` | `Editor/TestConsole.tsx` | Tabbed output panel: "Test Case" (pass/fail per case), "Execution" (stdout/stderr/timing), "Slide" (placeholder). Auto-switches tab on run/submit. Collapsible test case details. |

#### Problem Panel Components
| Component | File | Purpose |
|---|---|---|
| `ProblemDescription` | `ProblemPanel/ProblemDescription.tsx` | Problem title, difficulty badge (green/yellow/red), description, examples (input/output/explanation), constraints list, collapsible hints accordion. |
| `ProblemTabs` | `ProblemPanel/ProblemTabs.tsx` | Three tabs: Description, Problem List (hardcoded 5 problems with active highlight), Submission History. |
| `SubmissionHistory` | `ProblemPanel/SubmissionHistory.tsx` | List of past submissions. Status icons (green check / red X). Metadata: test pass count, timestamp, runtime, language. Click-to-load code back into editor. |

#### Homepage Components
| Component | File | Purpose |
|---|---|---|
| `HomepageClient` | `Homepage/HomepageClient.tsx` | Dashboard page. Fetches dashboard data (courses, progress, current question). Renders ProgressHero + CourseCard list. Skeleton loaders. |
| `ProgressHero` | `Homepage/ProgressHero.tsx` | Hero section with user avatar, greeting, overall progress stats. |
| `CourseCard` | `Homepage/CourseCard.tsx` | Course summary card with progress ring and problem count. |
| `CircularProgress` | `Homepage/CircularProgress.tsx` | SVG circular progress ring component. |

#### Course Components
| Component | File | Purpose |
|---|---|---|
| `CourseCatalogueClient` | `Course/CourseCatalogueClient.tsx` | Course list with search filter. Cards show image, progress ring, status label (In Progress/Completed/Not Started). |
| `CourseDetailClient` | `Course/CourseDetailClient.tsx` | Single course view with header + module accordion list. |
| `CourseHeader` | `Course/CourseHeader.tsx` | Course title, code, description, progress stats. |
| `ModuleAccordion` | `Course/ModuleAccordion.tsx` | Collapsible module with content items. |
| `ModuleList` | `Course/ModuleList.tsx` | List of ModuleAccordion components. |
| `ContentItemRow` | `Course/ContentItemRow.tsx` | Single content item (tutorial problem / quiz / exam) with lock/complete status. |

#### Profile Components
| Component | File | Purpose |
|---|---|---|
| `ProfileClient` | `Profile/ProfileClient.tsx` | Profile page with avatar upload + crop modal (drag + zoom, 300px canvas output). Form: name, email, occupation dropdown. Update mutation. |
| `ProfileSidebar` | `Profile/ProfileSidebar.tsx` | Profile navigation sidebar. |

#### Legal Components
| Component | File | Purpose |
|---|---|---|
| `PrivacyClient` | `Legal/PrivacyClient.tsx` | Privacy policy content. |
| `TermsClient` | `Legal/TermsClient.tsx` | Terms of service content. |

#### UI Primitives (shadcn-style)
| Component | File | Purpose |
|---|---|---|
| `Button` | `ui/button.tsx` | Button with variants (default, destructive, outline, secondary, ghost, link) and sizes. Uses `class-variance-authority`. |
| `Tabs` | `ui/tabs.tsx` | Radix-based tabs (TabsList, TabsTrigger, TabsContent). |
| `Tooltip` | `ui/tooltip.tsx` | Radix-based tooltip (TooltipProvider, TooltipTrigger, TooltipContent). |

### 6.3 Libraries & Utilities

#### API Clients (`lib/api/`)
| File | Functions | Purpose |
|---|---|---|
| `client.ts` | `API_BASE`, `makeHeaders(userId)` | Shared HTTP helper, injects `X-User-Id` header |
| `chat.ts` | `createSession`, `listSessions`, `getSession`, `saveMessage`, `deleteSession` | Chat session CRUD + message persistence |
| `judge0.ts` | `executeCode`, `submitCode` | Code execution (Run) and submission (Submit) |
| `courses.ts` | `fetchCourseList`, `fetchCourseDetail` | Course catalogue and detail |
| `dashboard.ts` | `fetchDashboard` | Homepage dashboard data |
| `drafts.ts` | `saveDraft`, `loadDraft` | Code draft autosave/load |
| `problems.ts` | `fetchProblemList`, `fetchProblem` | Problem list and detail |
| `profile.ts` | `fetchProfile`, `updateProfile` | User profile CRUD |
| `submissions.ts` | `fetchSubmissions` | Submission history |
| `notifications.ts` | `fetchNotifications`, `fetchUnreadCount`, `markNotificationsRead` | Notification management |

#### State Types (`lib/api/judge0.ts`)
```typescript
type ExecutionState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "success"; result: ExecutionResult }
  | { status: "error"; error: string }

type SubmissionState =
  | { status: "idle" }
  | { status: "running"; progress: { current: number; total: number } }
  | { status: "success"; result: SubmissionResult }
  | { status: "error"; error: string }
```

#### Hooks (`lib/hooks/`)
| Hook | Purpose |
|---|---|
| `useAutosave(problemId, language, code, userId, debounceMs=800)` | Debounced code draft saving. Returns `SaveStatus` ("idle" / "saving" / "saved" / "error"). Skips empty code, resets on problem/language change. Auto-resets status after 2-3s. |
| `useUserId()` | Extracts backend user ID from NextAuth session. |

#### Context (`lib/context/`)
| Context | Purpose |
|---|---|
| `UserProfileContext` | Provides `{ profile, isLoading, refreshProfile }`. Fetches profile on userId change. Used by profile page, avatar display, homepage greeting. |

#### Other Utilities
| File | Purpose |
|---|---|
| `tokens.ts` | Design tokens — colors (`bgSite: #0A0A0A`, `bgPanel: #1A1A1A`, `accentGreen: #2E7D32`, etc.) and layout constants (`columnCount: 3`, `topNavHeight: 48`, `gapSize: 4`). |
| `constants.ts` | `LANGUAGE_MAP` — maps display names (Python, JavaScript, C++, Java) to Judge0 IDs and Monaco language IDs. |
| `utils.ts` | General utilities (`cn()` class merger, etc.). |
| `format-time.ts` | Time formatting utility. |
| `mock-data.ts` | Mock data for development/testing. |

### 6.4 Styling System

**CSS Framework**: Tailwind CSS v4

**Theme**: Dark-only (`<html class="dark">` hardcoded in root layout)

**CSS Variables** (`globals.css`):
```css
:root {
  --background: 0 0% 4%;      /* #0A0A0A — near black */
  --foreground: 0 0% 100%;     /* white */
  --card: 0 0% 10%;            /* #1A1A1A — panel bg */
  --primary: 125 46% 33%;      /* #2E7D32 — VoidCode green */
  --secondary: 0 0% 15%;       /* #262626 — input bg */
  --muted: 0 0% 15%;           /* subtle elements */
  --destructive: 0 84% 60%;    /* red for errors */
  --border: 0 0% 20%;          /* #333333 — subtle borders */
  --ring: 125 46% 33%;         /* focus ring = primary green */
}
```

**Fonts** (loaded via `next/font/google`):
- **Inter** (`--font-inter`) — UI text
- **JetBrains Mono** (`--font-jetbrains-mono`) — Code editor
- **Playfair Display** (`--font-playfair`) — Decorative headings

**Custom scrollbar**: Dark themed, 8px width, rounded thumb.

**Tailwind config gotcha**: `darkMode: ["class", ".dark"]` — Tailwind v4 requires a 2-element tuple, not just `["class"]`.

### 6.5 Authentication

**Provider**: NextAuth v5 (beta) with two OAuth providers:

1. **Google OAuth** — Standard Google sign-in
2. **Microsoft Entra ID** — Scopes: `openid profile email User.Read`

**Flow**:
1. User clicks "Sign in with Google/Microsoft" on `/login`
2. NextAuth handles OAuth redirect and callback
3. `signIn` callback POSTs to backend `/v1/auth/login` with `{ email, name, provider, avatar_url }`
4. Backend finds or creates user, returns `{ id }`
5. Backend user ID stored in JWT token as `backendId`
6. All subsequent API calls include `X-User-Id` header

**Middleware** (`middleware.ts`):
- Unauthenticated users → redirect to `/login`
- Authenticated users on `/login` → redirect to `/homepage`
- `/api/auth/*` routes always allowed through
- Static assets (`_next/static`, `icons/`) excluded from middleware

**Login page**: Requires checking both Terms and Privacy Policy checkboxes before sign-in buttons are enabled. Branded VoidCode card with background image.

### 6.6 Public Assets

```
public/icons/
├── ic-voidcode-ai.svg        # VoidCode AI panel icon
├── ic-check-circle.svg    # Success/check icon
├── ic-edit.svg            # Edit icon
├── ic-fix-bug.svg         # Debug/fix icon
├── ic-notification.svg    # Bell notification icon
├── ic-run-code.svg        # Run code button (compound SVG with text paths)
├── ic-submit-code.svg     # Submit code button (compound SVG with text paths)
├── ic-user-profile.svg    # User avatar placeholder (58KB+, use next/image)
└── ic-x-circle.svg        # Error/close icon
```

> **Note**: `ic-run-code.svg` and `ic-submit-code.svg` are compound SVGs with embedded text paths. Use `next/image` from `public/icons/`. `ic-user-profile.svg` is very large (58KB+), always use `next/image`.

---

## 7. Backend — FastAPI (`apps/api`)

### 7.1 Application Entry Point (`main.py`)

The FastAPI app (~1,262 lines) is the central orchestrator:

- **Mode Detection**: Imports `detect_mode()`, `detect_frustration()` from `llm/scripts/prompts.py`
- **Dual Inference Paths**:
  - **HuggingFace** (`USE_VLLM=false`): `model.generate()` + BnB NF4 + PEFT adapter enable/disable
  - **vLLM** (`USE_VLLM=true`): `AsyncLLMEngine` + AWQ quantized model + PagedAttention
- **SSE Streaming**: Real-time token streaming via Server-Sent Events
- **`<think>` Tag Stripping**: Removes internal reasoning from responses
- **Concurrency**: `asyncio.Semaphore` with `_semaphore_wrapped()` pattern for streaming
- **Router Registration**: Auth, Chat, Courses, Dashboard, Drafts, Execution, Notifications, Problems, Profile

**Startup sequence**:
1. Load environment variables
2. Initialize database engine + run migrations
3. Initialize Redis connection
4. Load model (HF or vLLM based on `USE_VLLM`)
5. Register all routers under `/v1` prefix
6. Start uvicorn

### 7.2 vLLM Engine (`vllm_engine.py`)

Wrapper around vLLM's `AsyncLLMEngine` for production GPU inference:

- `init_engine()` — Initializes singleton engine with AWQ model
- `get_engine()` — Returns engine singleton
- `generate_stream_vllm()` — Streams SSE events with `data: {"content": "..."}` format
- `_make_lora_request()` — Always returns `None` (LoRA pre-merged into AWQ model)
- `_delta_event()` — Formats individual token deltas as SSE data lines

**AWQ model path resolution**: `MODEL_PATH` env var → `~/voidcode_models/awq_model` → `./llm/outputs/awq_model`

### 7.3 Database Layer

**Engine**: SQLAlchemy 2.x async with asyncpg driver

```python
# database.py
DATABASE_URL = "postgresql+asyncpg://voidcode:voidcode_pass@localhost:5433/voidcode_ai"
engine = create_async_engine(DATABASE_URL, echo=False)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)
```

**Dependency**: `get_db()` yields async session for FastAPI route injection.

### 7.4 Redis Layer

**Purpose**: Response caching (session lists, session details) + real-time notification pub/sub

```python
# redis_client.py
REDIS_URL = "redis://localhost:6380/0"  # host-exposed port
```

- `init_redis()` — Create and ping connection
- `close_redis()` — Cleanup on shutdown
- `get_redis()` — FastAPI dependency
- Cache TTLs: 5 min (session list first page), 10 min (session detail)
- Graceful degradation: app works without Redis (cache misses = DB queries)

### 7.5 Services

| Service | File | Key Functions |
|---|---|---|
| `ChatService` | `services/chat_service.py` | `create_session`, `list_sessions`, `get_session_with_messages`, `save_message`, `delete_session`. Redis caching with TTL. Auto-titles from first user message (50 chars + "..."). |
| `Judge0Client` | `services/judge0_client.py` | Async submit + poll pattern (not `?wait=true`). Base64 encoding. 10s submit timeout, 0.5s poll interval, 30s max wait. Singleton instance. `health_check()`. |
| `DraftService` | `services/draft_service.py` | `upsert_draft` (PostgreSQL `ON CONFLICT DO UPDATE`), `get_draft`. Atomic upsert for concurrent autosaves. |
| `SubmissionService` | `services/submission_service.py` | Submission persistence and history retrieval. |
| `ProfileService` | `services/profile_service.py` | Profile CRUD operations. |
| `NotificationService` | `services/notification_service.py` | Notification creation, listing, marking read. Redis pub/sub for SSE stream. |

### 7.6 Offline Scripts

| Script | Purpose | Usage |
|---|---|---|
| `merge_lora.py` | Merges LoRA adapter into Qwen 2.5 7B base weights (fp16, ~14 GB output) | `python -m scripts.merge_lora` |
| `quantize_awq.py` | W4A16 AWQ quantization using `llmcompressor` with domain-specific calibration (30 examples across 5 modes). Output ~5.26 GiB. | `python -m scripts.quantize_awq` |
| `seed_problems.py` | Populates problems table with problem definitions, examples, constraints, code templates, test cases. 5 problems. | `python -m scripts.seed_problems [--force]` |
| `seed_courses.py` | Populates courses, modules, content items. 2 courses (COS10009, SWE40006). Links problems to curriculum. | `python -m scripts.seed_courses [--force]` |

**Model preparation pipeline** (one-time, offline):
```
train.py → final_model/ (LoRA adapter)
    ↓
merge_lora.py → merged_model/ (fp16, ~14 GB)
    ↓
quantize_awq.py → awq_model/ (W4A16, ~5.26 GiB)
    ↓
Mount into Docker container at /models/awq_model
```

---

## 8. LLM Training Pipeline (`llm/`)

### 8.1 Scripts

| Script | Lines | Purpose |
|---|---|---|
| `prompts.py` | ~400 | System prompts (4 variants), mode detection (`detect_mode`, `detect_frustration`, `detect_problem_paste`), generation configs per mode, `strip_thinking_tags()`. |
| `train.py` | ~713 | Full QLoRA fine-tuning pipeline. Validates CUDA, loads data, applies 4-bit NF4 quantization, configures LoRA (r=16, alpha=32, 7 targets), trains 1 epoch with SFTTrainer, runs evaluation on 10 test prompts. |
| `update_system_prompts.py` | ~94 | Patches v52 → v53 system prompts in training data. Reads 1,700 v52 examples, replaces system message with current `FINETUNED_SYSTEM_PROMPT`, writes v53 output. |
| `generate_debug_examples_v53.py` | ~3,134 | Generates 160 new DEBUG training examples in 4 categories: multi-bug (65), hidden-bug (30), multi-turn conversational (45), mostly-correct encouragement (20). |
| `generate_gap_examples.py` | varies | General gap example generation utility. |
| `validate_prompt_match.py` | ~280 | Safety net — verifies every training record's system message matches `FINETUNED_SYSTEM_PROMPT` verbatim. Reports first mismatch with character position + context. Exit code 1 = do NOT train. |
| `evaluate_debug_quality.py` | ~1,137 | Phase 3 eval suite with 6 automated checks + heuristic rubric scoring. Compare mode for before/after analysis. |
| `patch_training_format.py` | varies | Format patching utility for training data. |
| `test_hybrid_model.py` | varies | Hybrid model testing script. |

### 8.2 Training Data

| File | Records | Purpose |
|---|---|---|
| `voidcode_training_data_v53.jsonl` | 1,850 | **Active training set** — 900 teaching + 750 debug + 200 followup |
| `voidcode_training_data_v52.jsonl` | 1,700 | Previous version (v5.2 system prompts) |
| `mode_teaching.jsonl` | 900 | Teaching mode source examples |
| `mode_debug.jsonl` | 600 | Debug mode source examples |
| `mode_followup.jsonl` | 200 | Follow-up mode source examples |
| `mode_explain.jsonl` | varies | Explain mode — **intentionally NOT merged** (base model is better) |
| `gap_debug_examples.jsonl` | 160 | Gap examples generated by `generate_debug_examples_v53.py` |
| `eval_debug_gold.jsonl` | 33 | Gold eval set (30 single-turn + 3 multi-turn) |
| `eval_baseline_before_v53.json` | — | Baseline eval results for comparison |

### 8.3 JSONL Format

```json
{
  "id": "teaching_two_sum_001",
  "mode": "teaching",
  "problem": "two_sum",
  "difficulty": "easy",
  "messages": [
    {"role": "system", "content": "<FINETUNED_SYSTEM_PROMPT verbatim>"},
    {"role": "user",   "content": "How do I solve Two Sum?"},
    {"role": "assistant", "content": "[EXPLAIN]\n...\n[TEMPLATE]\n...\n[GUIDE]\n..."}
  ]
}
```

### 8.4 Model Outputs

```
llm/outputs/
├── final_model/           # LoRA adapter only (~100 MB)
│   ├── adapter_config.json
│   ├── adapter_model.safetensors
│   └── tokenizer files...
│
├── merged_model/          # Base + LoRA merged fp16 (~14 GB)
│   ├── model.safetensors (sharded)
│   ├── model.safetensors.index.json
│   ├── config.json
│   └── tokenizer files...
│
├── awq_model/             # W4A16 quantized for vLLM (~5.26 GiB)
│   ├── model.safetensors (sharded)
│   ├── model.safetensors.index.json
│   ├── config.json
│   ├── recipe.yaml        # llmcompressor recipe
│   └── tokenizer files...
│
├── checkpoint-100/        # Training checkpoint
├── checkpoint-108/        # Training checkpoint
└── evaluation_results.json
```

---

## 9. Shared Types (`packages/shared`)

### `types/chat.ts`
```typescript
type MessageRole = 'user' | 'assistant' | 'system';
type TutorMode = 'TEACHING' | 'DEBUG' | 'FOLLOWUP' | 'EXPLAIN';

interface Message { id: string; role: MessageRole; content: string; timestamp: string; }
interface ChatSession { id: string; messages: Message[]; createdAt: string; updatedAt: string; userId: string; }
interface ChatRequest { messages: Message[]; maxTokens?: number; temperature?: number; }
interface ChatResponse { response: string; tokensUsed?: number; }
interface TutorModeConfig { mode: TutorMode; systemPrompt: string; temperature: number; maxTokens: number; }
```

### `types/api.ts`
```typescript
interface ApiResponse<T> { success: boolean; data?: T; error?: string; }
interface ApiError { code: number; message: string; details?: string; }
interface PaginatedResponse<T> { items: T[]; total: number; page: number; pageSize: number; hasMore: boolean; }
interface HealthCheckResponse { status: string; timestamp: string; services: { api: string; model: string; database?: string; }; }
```

### `types/user.ts`
```typescript
interface User { id: string; email: string; name: string; role: 'student' | 'instructor' | 'admin'; createdAt: string; updatedAt: string; }
interface UserPreferences { userId: string; theme: 'light' | 'dark' | 'system'; language: string; notifications: boolean; }
```

---

## 10. Docker Infrastructure

### 10.1 Compose Files

#### `docker-compose.yml` (Base Infrastructure)
- **PostgreSQL 16**: `voidcode:voidcode_pass@postgres:5432/voidcode_ai` → host `:5433`
- **Redis 7**: `redis:6379` → host `:6380`
- **Judge0 CE 1.13.1**: `:2358` → host `:2358` (has its own separate Postgres + Redis instances)

#### `docker-compose.gpu.yml` (GPU vLLM API)
- **vLLM API service**: CUDA 12.8, single GPU reservation
- AWQ model mounted read-only at `/models/awq_model`
- Environment: `GPU_MEMORY_UTILIZATION=0.90`, `MAX_MODEL_LEN=8192`
- Database URLs use Docker internal service names (`postgres:5432`, `redis:6379`)
- Depends on: postgres, redis, judge0-server

#### `docker-compose.dev.yml` (Development Overrides)
- Live source mounts:
  - `./apps/api/src → /app/apps/api/src`
  - `./llm/scripts/prompts.py → /app/llm/scripts/prompts.py`
  - `.env.docker` volume mount
- Increased logging: `TRANSFORMERS_VERBOSITY=info`
- Edit Python files locally → `docker restart voidcode-vllm-api` (~40s warm start)

#### `docker-compose.prod.yml` (Production Multi-GPU)
- 3 vLLM API replicas (`vllm-api-1`, `vllm-api-2`, `vllm-api-3`)
- Each pinned to GPU device ID 0/1/2 respectively
- Nginx load balancer on port `:8000`

### 10.2 GPU Dockerfile (`Dockerfile.gpu`)

```dockerfile
# Base: NVIDIA CUDA 12.8 + Ubuntu 24.04
FROM nvidia/cuda:12.8.0-devel-ubuntu24.04

# Python 3.12 (native on Ubuntu 24.04, no PPA needed)
RUN apt-get update && apt-get install -y python3.12 python3.12-venv python3-pip

# Isolated venv at /opt/venv
RUN python3.12 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Pre-install PyTorch BEFORE vLLM (CUDA 12.8, sm_120 Blackwell support)
RUN pip install torch==2.9.1 --extra-index-url https://download.pytorch.org/whl/cu128

# Install vLLM + uvloop
RUN pip install vllm==0.15.1 uvloop

# Install remaining dependencies
COPY requirements.gpu.txt .
RUN pip install -r requirements.gpu.txt

# Copy application code
COPY . /app
WORKDIR /app

EXPOSE 8000

# Single-worker uvicorn with uvloop
CMD ["uvicorn", "src.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--loop", "uvloop"]

HEALTHCHECK --start-period=120s --interval=30s CMD curl -f http://localhost:8000/health || exit 1
```

> **Key**: PyTorch MUST be pre-installed BEFORE vLLM. `requirements.gpu.txt` excludes torch/bitsandbytes/peft (vLLM provides them).

### 10.3 Nginx Load Balancer (`nginx.conf`)

```nginx
upstream vllm_backends {
    least_conn;
    server vllm-api-1:8000;
    server vllm-api-2:8000;
    server vllm-api-3:8000;
}

server {
    listen 8000;

    location / {
        proxy_pass http://vllm_backends;

        # SSE compatibility
        proxy_buffering off;
        proxy_cache off;
        proxy_request_buffering off;

        # 300s timeout for long generations (8,192 tokens @ 30 tok/s ≈ 273s)
        proxy_read_timeout 300s;
    }
}
```

---

## 11. Database Schema

### Entity Relationship Summary

```
User ──┬── UserPreferences (1:1)
       ├── ChatSession ── ChatMessage (1:N)
       ├── Submission ── TestCaseResult (1:N)
       ├── CodeDraft (unique: user + problem + language)
       └── Notification

Course ──┬── Problem ── TestCase (1:N)
         │             └── CodeTemplate (unique: problem + language)
         └── Module ── ContentItem ── Problem (optional FK)
```

### Table Details

| Table | Key Fields | Indexes |
|---|---|---|
| `users` | id (UUID PK), email (unique), name, role (student/instructor/admin), bio, birth_date, country, occupation, profile_photo_url, timezone, created_at, updated_at | email |
| `user_preferences` | id (UUID PK), user_id (FK unique), theme, preferred_language, notifications_enabled | user_id |
| `problems` | id (UUID PK), slug (unique), title, difficulty (easy/medium/hard), description, examples (JSON), constraints (JSON), hints (JSON), order_index, course_id (FK nullable), is_published | difficulty + order_index |
| `test_cases` | id (UUID PK), problem_id (FK), label, inputs (JSON), stdin, expected_output, order_index, is_hidden | problem_id |
| `code_templates` | id (UUID PK), problem_id (FK), language, judge0_language_id, template_code, driver_code (nullable) | problem_id + language (unique) |
| `submissions` | id (UUID PK), user_id (FK), problem_id (FK), source_code, language, judge0_language_id, status (enum), total_tests, passed_tests, overall_runtime_ms, overall_memory_kb, created_at | user_id + problem_id + created_at |
| `test_case_results` | id (UUID PK), submission_id (FK), test_case_id (FK nullable), passed, stdout, stderr, compile_output, status_id, status_description, runtime_ms, memory_kb, expected_output, actual_output | submission_id |
| `chat_sessions` | id (UUID PK), user_id (FK), problem_id (FK nullable), title, is_active, created_at, updated_at | user_id |
| `chat_messages` | id (UUID PK), session_id (FK), role (user/assistant/system), content, detected_mode (nullable), thinking_content, thinking_token_count, thinking_budget_used, prompt_tokens, completion_tokens, created_at | session_id + created_at |
| `courses` | id (UUID PK), code (unique), title, description, image_url, order_index, is_published, created_at, updated_at | code |
| `modules` | id (UUID PK), course_id (FK), title, description, sort_order, is_published, created_at, updated_at | course_id |
| `content_items` | id (UUID PK), module_id (FK), problem_id (FK nullable), item_type (tutorial_problem/quiz/exam), title, sort_order, is_published, created_at | module_id |
| `code_drafts` | id (UUID PK), user_id (FK), problem_id (FK), language, source_code, updated_at | user_id + problem_id (unique: user_id + problem_id + language) |
| `notifications` | id (UUID PK), user_id (FK), type (submission_accepted/failed/welcome/streak/system), title, message, is_read, reference_id (nullable), created_at | user_id + is_read + created_at |

---

## 12. API Endpoints Reference

### Authentication
| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/auth/login` | Find or create user by email. Returns `{ id }`. Creates welcome notification for new users. |

### Chat / VoidCode AI
| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/chat/sessions` | Create new chat session. Body: `{ problem_id?, title? }` |
| GET | `/v1/chat/sessions` | List sessions (newest first). Query: `limit=20`, `offset=0`. Cached 5 min (first page). |
| GET | `/v1/chat/sessions/{id}` | Get session with all messages. Cached 10 min. |
| POST | `/v1/chat/sessions/{id}/messages` | Save message. Body: `{ role, content, detected_mode?, thinking_*, token_counts }`. Auto-titles session from first user message. |
| DELETE | `/v1/chat/sessions/{id}` | Delete session + cascade messages. |

### AI Inference (Streaming)
| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/chat` | SSE streaming chat completion. Body: `{ messages[], max_tokens?, temperature? }`. Mode auto-detected. Returns `data: {"content": "..."}` events. |

### Problems
| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/problems` | List all published problems (summary: id, slug, title, difficulty). |
| GET | `/v1/problems/{slug}` | Full problem detail with test cases (non-hidden only) + code templates. |

### Code Execution
| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/execute` | Run code once. Body: `{ source_code, language_id, stdin?, expected_output? }`. Returns stdout/stderr/timing. |
| POST | `/v1/submit` | Submit against all test cases. Body: `{ source_code, language_id, test_cases[], problem_id, language }`. Persists to DB. |
| GET | `/v1/submissions` | Get 15 most recent submissions. Query: `problem_id`, `user_id`. |

### Code Drafts
| Method | Path | Purpose |
|---|---|---|
| PUT | `/v1/drafts` | Upsert draft (one per user+problem+language). Body: `{ problem_id, language, source_code }`. |
| GET | `/v1/drafts` | Get current draft. Query: `problem_id`, `language` (default: Python). |

### Courses
| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/courses` | List published courses with progress. Returns total_items, completed_items, progress_percentage. |
| GET | `/v1/courses/{code}` | Full course tree with modules, content items, lock states, user progress. |

### Dashboard
| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/dashboard` | Aggregated dashboard: courses, current_question, total/solved problems. |

### Profile
| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/profile` | Get current user's profile. |
| PUT | `/v1/profile` | Update profile. Body: `{ name?, bio?, occupation?, country?, timezone?, birth_date? }`. |

### Notifications
| Method | Path | Purpose |
|---|---|---|
| GET | `/v1/notifications` | List notifications. Query: `unread_only`, `limit`. Returns notifications + unread_count + total. |
| GET | `/v1/notifications/count` | Lightweight unread badge count. |
| GET | `/v1/notifications/stream` | SSE real-time stream via Redis pub/sub. Events: connected, heartbeat (30s), notification. |
| PATCH | `/v1/notifications/read` | Mark as read. Body: `{ notification_ids[] }` (empty = all). |

### Health
| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Service health check. Returns model, database, redis, judge0 status. |

**Common patterns**:
- User ID from `X-User-Id` header (set by frontend `makeHeaders()`)
- All UUIDs as strings in JSON
- Timestamps as ISO 8601
- Non-fatal DB persistence in execution endpoint (returns result even if save fails)

---

## 13. Authentication Flow

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│   Browser    │────>│   Next.js    │────>│   FastAPI    │
│   (Login)    │     │   NextAuth   │     │   /v1/auth   │
└─────────────┘     └──────────────┘     └──────────────┘
      │                     │                     │
      │  1. Click           │                     │
      │  "Sign in"          │                     │
      │─────────────────────>                     │
      │                     │  2. OAuth redirect  │
      │                     │  to Google/MS       │
      │<────────────────────│                     │
      │                     │                     │
      │  3. OAuth callback  │                     │
      │─────────────────────>                     │
      │                     │  4. POST /v1/auth/  │
      │                     │  login {email,name, │
      │                     │  provider,avatar}   │
      │                     │─────────────────────>
      │                     │                     │  5. Find or
      │                     │                     │  create user
      │                     │  6. Return {id}     │
      │                     │<─────────────────────
      │                     │                     │
      │                     │  7. Store backendId │
      │                     │  in JWT token       │
      │  8. Redirect to     │                     │
      │  /homepage          │                     │
      │<────────────────────│                     │
      │                     │                     │
      │  9. All API calls   │                     │
      │  include X-User-Id  │                     │
      │  header from JWT    │                     │
```

---

## 14. VoidCode AI Mode System

### Mode Detection Priority (`prompts.py → detect_mode()`)

```
User Message
    │
    ▼
1. EMPATHY — detect_frustration() override
   Keywords: "i'm dumb", "i give up", "completely lost", "hate coding", "want to cry"
   → Base model (adapter disabled), EMPATHY_SYSTEM_PROMPT
    │ (no match)
    ▼
2. TEACHING — detect_problem_paste()
   Detects LeetCode/Codeforces format: "Given...", "Return...", "Example:", LaTeX
   → Fine-tuned adapter, FINETUNED_SYSTEM_PROMPT
    │ (no match)
    ▼
3. DEBUG — code block + error/fix keywords
   Patterns: "```" + ("error", "bug", "wrong", "fix", "issue", "fail")
   → Fine-tuned adapter, FINETUNED_SYSTEM_PROMPT
    │ (no match)
    ▼
4. TEACHING — explicit solve/implement keywords
   Patterns: "solve", "implement", "approach", known problem names
   → Fine-tuned adapter, FINETUNED_SYSTEM_PROMPT
    │ (no match)
    ▼
5. EXPLAIN — concept clarification + programming context
   Patterns: "what is", "how does", "explain", "difference between"
   → Base model (adapter disabled), EXPLAIN_SYSTEM_PROMPT
    │ (no match)
    ▼
6. FOLLOWUP — short continuations
   Patterns: "yes", "no", "what about", "and", complexity questions
   → Fine-tuned adapter, FINETUNED_SYSTEM_PROMPT
    │ (no match)
    ▼
7. GENERAL — non-programming fallback
   → Base model (adapter disabled), NON_PROGRAMMING_SYSTEM_PROMPT
```

### Response Formats

#### TEACHING MODE: `[EXPLAIN] → [TEMPLATE] → [GUIDE]`
```
[EXPLAIN]
Brief explanation of approach (2-3 sentences).

[TEMPLATE]
```python
def solution(args):
    result = ____          # Line 1
    for item in ____:      # Line 2
        if ____:           # Line 3
            ____           # Line 4
    return ____            # Line 5
```

[GUIDE]
Line 1: What data structure should we use to store seen values?
Line 2: What are we iterating over?
Line 3: What condition tells us we found a match?
Line 4: What should we return when we find a match?
Line 5: What do we return if no match is found?
```

#### DEBUG MODE: `Issue N — Line X`
```
I found 2 issues in your code.

**Issue 1 — Line 5**
```python
if nums[i] + nums[j] == :
```
Line 5 has == with nothing on the right side — Python raises a SyntaxError...
What value should go after ==?

**Issue 2 — Line 6**
```python
return []
```
Line 6 returns an empty list. Because the SyntaxError on line 5 prevents execution...
What two variables hold the positions of the matching numbers?

---
Let's fix Issue 1 first since the code cannot run at all until line 5 is valid.
What value should go after ==?
```

#### EXPLAIN MODE: Code-first, plain English
```
```python
for i in range(len(nums)):
```
This loops through all valid indices of the list `nums`...
```

#### FOLLOWUP MODE: Brief (1-3 sentences)
```
Yes! Each hash map lookup is O(1), and you do one per element — so n × O(1) = O(n) total.
```

#### EMPATHY MODE: Warm support first
```
Hey, don't be hard on yourself — this kind of thing trips everyone up!
The fact that you're stuck means you're right at the edge of understanding it.
[One simple thing from previous hint]
[One ultra-simple guiding question]
You're closer than you think!
```

### Inference Mode → Adapter State

| Mode | LoRA Adapter | System Prompt |
|---|---|---|
| TEACHING | **Enabled** | FINETUNED_SYSTEM_PROMPT |
| DEBUG | **Enabled** | FINETUNED_SYSTEM_PROMPT |
| FOLLOWUP | **Enabled** | FINETUNED_SYSTEM_PROMPT |
| EXPLAIN | **Disabled** | EXPLAIN_SYSTEM_PROMPT |
| GENERAL | **Disabled** | NON_PROGRAMMING_SYSTEM_PROMPT |
| EMPATHY | **Disabled** | EMPATHY_SYSTEM_PROMPT |

> In the vLLM path, LoRA is pre-merged into the AWQ model — adapter enable/disable has no effect. All mode differentiation happens via system prompt injection.

### Generation Parameters by Mode

| Mode | Temperature | Max Tokens | Repetition Penalty |
|---|---|---|---|
| TEACHING | 0.3 | 1024 | 1.1 |
| DEBUG | 0.3 | 1024 | 1.1 |
| FOLLOWUP | 0.4 | 256 | 1.05 |
| EXPLAIN | 0.5 | 768 | 1.1 |
| GENERAL | 0.7 | 512 | 1.1 |
| EMPATHY | 0.6 | 512 | 1.05 |

---

## 15. Training Pipeline Workflow

### Step-by-Step

```bash
# Step 1: Patch existing training data to current system prompt
python llm/scripts/update_system_prompts.py
# Reads v52 (1,700 examples) → patches system messages → writes v53

# Step 2: Generate new gap training examples (appends to v53)
python llm/scripts/generate_debug_examples_v53.py
# Generates 160 DEBUG examples in 4 categories → appends to v53
# Total: 1,700 + 160 = 1,860 (minus 10 deduped = 1,850)

# Step 3: Validate prompt alignment BEFORE training
python llm/scripts/validate_prompt_match.py
# Exit 0 = safe to train. Exit 1 = MISMATCH, do NOT train.
# If fails: run update_system_prompts.py again, then re-validate.

# Step 4: Run training
python llm/scripts/train.py
# QLoRA fine-tuning: 1 epoch, ~1,850 examples
# Output: llm/outputs/final_model/ (LoRA adapter, ~100 MB)

# Step 5: Evaluate DEBUG mode quality
python llm/scripts/evaluate_debug_quality.py
python llm/scripts/evaluate_debug_quality.py --rubric-score --verbose
```

### Training Configuration

```yaml
# Model
base_model: Qwen/Qwen2.5-7B-Instruct
quantization: 4-bit NF4 (BitsAndBytes)
compute_dtype: bfloat16

# LoRA
lora_rank: 16
lora_alpha: 32
lora_dropout: 0.05
target_modules:
  - q_proj
  - v_proj
  - k_proj
  - o_proj
  - up_proj
  - down_proj
  - gate_proj

# Training
num_epochs: 1
per_device_train_batch_size: 2
gradient_accumulation_steps: 16
effective_batch_size: 32  # 2 × 16
learning_rate: 1e-4
lr_scheduler: cosine
max_seq_length: 1024  # or 1536 / 2048

# Profiles
Profile A (Balanced - 16GB VRAM):
  max_seq_length: 1536
  batch_size: 2
  grad_accum: 16

Profile B (Memory-Safe - if OOM):
  max_seq_length: 1024
  batch_size: 1
  grad_accum: 32
```

### Validation Rules by Mode (`train.py → validate_example()`)

| Mode | Rules |
|---|---|
| TEACHING | Must contain `[EXPLAIN]`, `[TEMPLATE]`, `[GUIDE]` in correct order. Must have blanks (`____`). Must have question in guide. |
| DEBUG | Accepts old format (emoji markers) OR new format (`Issue N — Line X` + question mark) OR correct-code format. |
| FOLLOWUP | Content only, no special tags, 1-3 sentences. |
| EXPLAIN | Skipped — not in training data (uses base model). |

### Critical Constraint — System Prompt Verbatim Match

The system message in every training record MUST be verbatim identical to `FINETUNED_SYSTEM_PROMPT` in `prompts.py`. Any divergence causes **distribution shift** — the model produces garbled output (observed: 43-token garbage instead of structured response).

**Safety net**: `validate_prompt_match.py` exits with code 1 if any mismatch is found. Always run before training.

---

## 16. Model Inference Architecture

### HuggingFace Path (Local Dev, `USE_VLLM=false`)

```
User Message
    ↓
detect_mode() → mode
    ↓
get_system_prompt(mode) → system prompt
get_generation_config(mode) → temperature, max_tokens, etc.
    ↓
if mode in (TEACHING, DEBUG, FOLLOWUP):
    model.enable_adapter()    # LoRA active
else:
    model.disable_adapter()   # Base model only
    ↓
tokenizer.apply_chat_template(messages)
    ↓
model.generate(input_ids, **gen_config)
    ↓
strip_thinking_tags(response)  # Remove <think>...</think>
    ↓
SSE stream to client
```

### vLLM Path (Production, `USE_VLLM=true`)

```
User Message
    ↓
detect_mode() → mode
    ↓
get_system_prompt(mode) → system prompt
get_generation_config(mode) → SamplingParams
    ↓
(LoRA pre-merged into AWQ model — no adapter toggle needed)
    ↓
tokenizer.apply_chat_template(messages)
    ↓
AsyncLLMEngine.generate(prompt, sampling_params)
    ↓
Async iterator → SSE stream: data: {"content": "token"}
    ↓
strip_thinking_tags() applied per-chunk
    ↓
data: [DONE]
```

### Model Preparation Pipeline (One-Time, Offline)

```
Qwen/Qwen2.5-7B-Instruct (HuggingFace Hub)
    ↓ train.py (QLoRA fine-tuning)
llm/outputs/final_model/ (LoRA adapter, ~100 MB)
    ↓ merge_lora.py
llm/outputs/merged_model/ (fp16, ~14 GB)
    ↓ quantize_awq.py (llmcompressor, W4A16, domain calibration)
llm/outputs/awq_model/ (~5.26 GiB)
    ↓ Mount into Docker at /models/awq_model
vLLM AsyncLLMEngine (PagedAttention, CUDA kernels)
```

### Concurrency Control

```python
# main.py
_semaphore = asyncio.Semaphore(MAX_CONCURRENT_REQUESTS)  # default: 8

# Non-streaming: acquire in try/finally
async with _semaphore:
    response = await generate(...)

# Streaming: wrapper holds permit until stream ends
async def _semaphore_wrapped(stream):
    async with _semaphore:
        async for chunk in stream:
            yield chunk

# Flag pattern prevents double-release
_semaphore_held_by_wrapper = True  # streaming release via wrapper
_semaphore_held_by_wrapper = False # non-streaming release via finally
```

---

## 17. Evaluation Suite

### Gold Eval Set (`eval_debug_gold.jsonl`)

**30 single-turn scenarios**:
- Syntax errors (missing colon, unmatched brackets, etc.)
- Logic bugs (off-by-one, wrong operator, incorrect return)
- Multi-bug (2-3 bugs in one submission)
- Masked bugs (hidden by earlier errors)
- Mostly-correct code (no bugs, needs encouragement)
- Tree/graph problems (advanced data structures)

**3 multi-turn scenarios**:
- Student confusion (asks same question differently)
- Frustration escalation (triggers EMPATHY override)
- Partial answer (student fixes one bug, asks about next)

### 6 Automated Checks

| Check | What It Verifies |
|---|---|
| BugCnt | Model states the correct number of bugs |
| NoDupe | Each line number appears in at most 1 Issue block |
| SrcCit | Response cites at least 1 line number from student's code |
| NoLeak | No complete fixed code in response (Socratic — don't give answers) |
| GuidQ | Contains at least 1 question mark (guiding question) |
| PosFrm | Includes encouraging word/phrase (positive framing) |

### Heuristic Rubric (Optional `--rubric-score`)

5 dimensions, each scored 1-5 (no LLM needed):
1. **Completeness** — Are all bugs identified?
2. **Analysis Depth** — Does it explain *why* each bug is wrong?
3. **Pedagogical Quality** — Are guiding questions effective?
4. **Tone** — Encouraging without being condescending?
5. **Conciseness** — Focused without unnecessary verbosity?

### Usage

```bash
# Run full eval against live API
python llm/scripts/evaluate_debug_quality.py

# With rubric scores
python llm/scripts/evaluate_debug_quality.py --rubric-score --verbose

# Compare before/after
python llm/scripts/evaluate_debug_quality.py --compare \
    llm/data/eval_results_baseline.json \
    llm/data/eval_results_post-retrain.json

# Single scenario
python llm/scripts/evaluate_debug_quality.py --scenario eval_two_sum_multibug_001 --verbose

# Offline (pre-recorded responses)
python llm/scripts/evaluate_debug_quality.py --responses-file my_responses.json --rubric-score
```

---

## 18. Tunnel & Remote Access

### Cloudflare Tunnel (Free Tier)

**`tunnel-config.yml`** (template for named tunnel):
```yaml
tunnel: <tunnel-id>
credentials-file: <credentials-path>
ingress:
  - hostname: voidcode-ai.your-domain.com
    service: http://localhost:3000        # Frontend
  - hostname: voidcode-api.your-domain.com
    service: http://localhost:8000        # Backend API
    originRequest:
      noTLSVerify: true
  - service: http_status:404              # Catch-all
```

### Quick Tunnels (`start-tunnels.bat`)

Windows batch script that launches two **free** Cloudflare tunnels with random subdomains:

```batch
@echo off
echo Starting VoidCode AI tunnels...

REM Backend tunnel (port 8000)
start "Backend Tunnel" cloudflared tunnel --url http://localhost:8000

REM Frontend tunnel (port 3000)
start "Frontend Tunnel" cloudflared tunnel --url http://localhost:3000

echo Copy the generated URLs to apps/web/.env.local:
echo   NEXT_PUBLIC_API_URL=<backend-tunnel-url>
echo   AUTH_URL=<frontend-tunnel-url>
```

**After starting tunnels**:
1. Copy the randomly generated backend URL
2. Set `NEXT_PUBLIC_API_URL=<backend-url>` in `apps/web/.env.local`
3. Copy the frontend URL
4. Set `AUTH_URL=<frontend-url>` in `apps/web/.env.local`
5. Update OAuth redirect URIs in Google/Microsoft portals

---

## 19. Gotchas & Lessons Learned

### Frontend

| Issue | Solution |
|---|---|
| **Tailwind v4 darkMode** | Must use `["class", ".dark"]` not `["class"]` — v4 `Config` type requires 2-element tuple |
| **`as const` + useState** | When tokens use `as const`, `useState(literal)` infers literal type. Must explicitly type: `useState<number>(token)` |
| **SVG icons** | Some are compound (ic-run-code, ic-submit-code) with embedded text paths. Use `next/image` from `public/icons/`. Simple icons inline as JSX. |
| **user-profile.svg** | Very large (58KB+), too big to read inline. Always use `next/image` from public. |
| **Next.js 16 params** | Dynamic route params are `Promise<{id: string}>`, must `await params` |
| **Extra lockfile** | `apps/web/package-lock.json` exists alongside `pnpm-lock.yaml` — causes benign warning |

### Backend / Docker

| Issue | Solution |
|---|---|
| **Docker internal ports** | Use `postgres:5432` (not 5433), `redis:6379` (not 6380) inside containers |
| **PyTorch before vLLM** | PyTorch CUDA must be pre-installed BEFORE vLLM in Dockerfile |
| **WSL2 + Judge0** | From WSL2, `localhost` is WSL2's loopback. Use Windows IP from `/etc/resolv.conf` for Docker on Windows. |
| **Tokenizer loading** | Load from AWQ model dir (`MODEL_PATH`) to avoid HuggingFace Hub network call inside container |
| **Concurrency streaming** | `_semaphore_held_by_wrapper` flag pattern separates streaming release (wrapper) from non-streaming release (finally block) |

### LLM / Training

| Issue | Solution |
|---|---|
| **System prompt mismatch** | Causes distribution shift — model outputs 43-token garbage. Always run `validate_prompt_match.py` before training. |
| **EXPLAIN mode training** | Excluded from training data intentionally. Base model's 18T pre-training tokens produce better explanations than fine-tuned examples. |
| **AWQ model path** | Resolution order: `MODEL_PATH` env var → `~/voidcode_models/awq_model` → `./llm/outputs/awq_model` |
| **Triton kernels** | `triton==3.5.1` required for PagedAttention CUDA kernels on sm_120 (Blackwell architecture) |

---

## 20. File Inventory

### Complete File Count by Area

| Area | Files | Description |
|---|---|---|
| Frontend (apps/web) | ~75 | TypeScript/TSX components, pages, utilities, configs |
| Backend (apps/api) | ~42 | Python models, routers, services, schemas, migrations, scripts |
| LLM Pipeline (llm/) | ~20 | Training scripts, data files, model outputs |
| Shared Types | ~5 | TypeScript type definitions |
| Docker / Infra | ~8 | Compose files, Dockerfiles, nginx, tunnel config |
| Documentation | ~11 | Markdown documentation files |
| Root Config | ~6 | turbo.json, pnpm-workspace, package.json, .gitignore |
| **Total** | **~167** | |

### Frontend Files (`apps/web/src/`)

```
app/
├── globals.css
├── layout.tsx
├── page.tsx
├── login/page.tsx
├── api/auth/[...nextauth]/route.ts
├── (homepage)/layout.tsx
├── (homepage)/homepage/page.tsx
├── (homepage)/courses/page.tsx
├── (homepage)/courses/[code]/page.tsx
├── (homepage)/privacy/page.tsx
├── (homepage)/terms/page.tsx
├── (profile)/layout.tsx
├── (profile)/profile/page.tsx
├── (profile)/privacy/page.tsx
├── (profile)/terms/page.tsx
├── (workspace)/layout.tsx
└── (workspace)/problems/[id]/page.tsx

components/
├── VoidCodeAI/VoidCodeAIPanel.tsx
├── VoidCodeAI/ChatHistoryDropdown.tsx
├── VoidCodeAI/ChatMessage.tsx
├── VoidCodeAI/ReviewTemplateBlock.tsx
├── VoidCodeAI/ThinkingBlock.tsx
├── Course/ContentItemRow.tsx
├── Course/CourseCatalogueClient.tsx
├── Course/CourseDetailClient.tsx
├── Course/CourseHeader.tsx
├── Course/ModuleAccordion.tsx
├── Course/ModuleList.tsx
├── Editor/CodeColumn.tsx
├── Editor/MonacoWrapper.tsx
├── Editor/TestConsole.tsx
├── Homepage/CircularProgress.tsx
├── Homepage/CourseCard.tsx
├── Homepage/HomepageClient.tsx
├── Homepage/ProgressHero.tsx
├── Layout/AppFooter.tsx
├── Layout/NotificationBell.tsx
├── Layout/ResizableLayout.tsx
├── Layout/TopNavigation.tsx
├── Layout/WorkspaceClient.tsx
├── Legal/PrivacyClient.tsx
├── Legal/TermsClient.tsx
├── ProblemPanel/ProblemDescription.tsx
├── ProblemPanel/ProblemTabs.tsx
├── ProblemPanel/SubmissionHistory.tsx
├── Profile/ProfileClient.tsx
├── Profile/ProfileSidebar.tsx
├── Providers.tsx
├── ui/button.tsx
├── ui/tabs.tsx
└── ui/tooltip.tsx

lib/
├── api/chat.ts
├── api/client.ts
├── api/courses.ts
├── api/dashboard.ts
├── api/drafts.ts
├── api/judge0.ts
├── api/notifications.ts
├── api/problems.ts
├── api/profile.ts
├── api/submissions.ts
├── context/UserProfileContext.tsx
├── hooks/useAutosave.ts
├── hooks/useUserId.ts
├── constants.ts
├── format-time.ts
├── mock-data.ts
├── tokens.ts
└── utils.ts

auth.ts
auth.d.ts
middleware.ts
```

### Backend Files (`apps/api/`)

```
src/
├── main.py
├── vllm_engine.py
├── database.py
├── redis_client.py
├── __init__.py
├── models/
│   ├── __init__.py
│   ├── user.py
│   ├── problem.py
│   ├── submission.py
│   ├── chat.py
│   ├── course.py
│   ├── curriculum.py
│   ├── draft.py
│   └── notification.py
├── routers/
│   ├── __init__.py
│   ├── auth.py
│   ├── chat.py
│   ├── courses.py
│   ├── dashboard.py
│   ├── drafts.py
│   ├── execution.py
│   ├── notifications.py
│   ├── problems.py
│   └── profile.py
├── schemas/
│   ├── __init__.py
│   ├── chat.py
│   ├── draft.py
│   ├── notification.py
│   └── profile.py
└── services/
    ├── __init__.py
    ├── chat_service.py
    ├── draft_service.py
    ├── judge0_client.py
    ├── notification_service.py
    ├── profile_service.py
    └── submission_service.py

alembic/
├── alembic.ini
├── env.py
├── script.py.mako
└── versions/
    ├── ac9a1b3b96f9_initial_schema.py
    ├── 3ac4f79184db_add_courses_table.py
    ├── 9024b6255687_add_driver_code_to_code_templates.py
    ├── 93f288d0e905_add_code_drafts_table.py
    ├── a7b2c3d4e5f6_add_modules_and_content_items.py
    ├── c3f7a8d91e02_add_profile_and_notifications.py
    └── f43c1af6356d_add_timezone_to_users.py

scripts/
├── __init__.py
├── merge_lora.py
├── quantize_awq.py
├── seed_problems.py
└── seed_courses.py
```

### LLM Files (`llm/`)

```
scripts/
├── prompts.py
├── train.py
├── update_system_prompts.py
├── generate_debug_examples_v53.py
├── generate_gap_examples.py
├── validate_prompt_match.py
├── evaluate_debug_quality.py
├── patch_training_format.py
└── test_hybrid_model.py

data/
├── voidcode_training_data_v53.jsonl    (1,850 examples — ACTIVE)
├── voidcode_training_data_v52.jsonl    (1,700 examples — previous)
├── mode_teaching.jsonl                  (900 examples)
├── mode_debug.jsonl                     (600 examples)
├── mode_followup.jsonl                  (200 examples)
├── mode_explain.jsonl                   (NOT merged — intentional)
├── gap_debug_examples.jsonl             (160 examples)
├── eval_debug_gold.jsonl                (33 eval scenarios)
└── eval_baseline_before_v53.json        (baseline results)

outputs/
├── final_model/                         (~100 MB LoRA adapter)
├── merged_model/                        (~14 GB merged fp16)
├── awq_model/                           (~5.26 GiB W4A16)
├── checkpoint-100/
├── checkpoint-108/
└── evaluation_results.json

configs/
└── training_config.yaml
```

### Root Files

```
package.json
pnpm-workspace.yaml
pnpm-lock.yaml
turbo.json
.gitignore
docker-compose.yml
docker-compose.dev.yml
docker-compose.gpu.yml
docker-compose.prod.yml
nginx.conf
tunnel-config.yml
start-tunnels.bat
AGENTS.md
README.md
ARCHITECTURE.md
DOCKER_GPU_INFERENCE.md
ENGINEERING_RECOMMENDATION.md
FUTURE_IMPLEMENTATION.md
LLM_ARCHITECTURE.md
MODEL_IMPROVEMENT_PROMPT.md
PHASE_CHECKLIST.md
TUNNEL_SETUP.md
UNIVERSITY_INFRA_SPEC.md
```

---

## Quick Reference — Common Commands

```bash
# === DEVELOPMENT ===
pnpm install                              # Install all deps
pnpm dev:web                              # Start frontend (:3000)
docker compose up -d                       # Start Postgres + Redis + Judge0
cd apps/api && uvicorn src.main:app --port 8000 --reload  # Start API (local)

# === DOCKER GPU ===
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
docker logs -f voidcode-vllm-api         # Wait for startup
curl http://localhost:8000/health          # Health check

# === DOCKER GPU DEV ===
docker compose -f docker-compose.yml -f docker-compose.gpu.yml -f docker-compose.dev.yml up -d
docker restart voidcode-vllm-api         # After editing .py files

# === DATABASE ===
cd apps/api && alembic upgrade head       # Run migrations
python -m scripts.seed_problems           # Seed problems
python -m scripts.seed_courses            # Seed courses

# === TRAINING ===
python llm/scripts/update_system_prompts.py
python llm/scripts/generate_debug_examples_v53.py
python llm/scripts/validate_prompt_match.py
python llm/scripts/train.py
python llm/scripts/evaluate_debug_quality.py --rubric-score --verbose

# === MODEL PREPARATION (one-time) ===
python -m scripts.merge_lora              # LoRA → merged fp16
python -m scripts.quantize_awq            # fp16 → AWQ W4A16

# === BUILD ===
npx turbo build --filter=@voidcode/web   # Build frontend

# === PRODUCTION ===
docker compose -f docker-compose.yml -f docker-compose.gpu.yml -f docker-compose.prod.yml up -d

# === TUNNELS ===
start-tunnels.bat                         # Launch Cloudflare tunnels
```

---

*This document captures the complete implementation state of the VoidCode AI v5.3 project as of 2026-03-12.*
