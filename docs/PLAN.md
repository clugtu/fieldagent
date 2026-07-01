# FieldAgent — Design Plan

## What It Is

FieldAgent is a Chrome extension + AI microservice whose job is exactly
what the name suggests: fill in web forms.

Any app or script can hand FieldAgent a task — "fill a Facebook post
with this caption" or "fill a job application with these details" — and
FieldAgent's Inspector Agent figures out how to map that content onto
whatever is currently on screen. The human user reviews the result and
submits. FieldAgent never clicks Submit.

It is platform-agnostic at the code level. The agent adapts to what it
sees on screen rather than relying on hardcoded selectors, which means
it degrades gracefully when a site redesigns its form layout.

---

## The Name

- **Field agent** — an operative working out in the world, navigating
  unfamiliar terrain, executing a mission handed down from HQ
- **Field agent** — an AI agent that works in form *fields* on web pages

---

## Core Principles

1. **The extension is an actuator, not a brain.** It extracts DOM state
   and applies instructions. All reasoning lives in the service.
2. **The service hosts the actual agent.** An LLM-backed Inspector Agent
   receives DOM snapshots, decides what to fill and how, handles
   unexpected page states, and knows when more steps are coming.
3. **The user always submits.** FieldAgent pre-fills; the user reviews
   and clicks Publish / Submit / Next. No autonomous form submission.
4. **Generic by design.** The service has no hardcoded knowledge of
   specific sites. The agent reads the page and figures it out.
5. **Standalone and publishable.** No dependency on any particular app.
   Any producer that can make an HTTP POST can use FieldAgent.

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Any producer (app, script, CLI)                         │
│  POST /tasks  →  FieldAgent Service                      │
└──────────────────────────┬───────────────────────────────┘
                           │ enqueue task
                           ▼
┌──────────────────────────────────────────────────────────┐
│  FieldAgent Service  (FastAPI + LangChain)               │
│                                                          │
│  • Task queue  (pending → active → complete)             │
│  • Inspector Agent  — receives DOM snapshots, returns    │
│    structured fill instructions. Multi-step aware.       │
└──────────────────────────┬───────────────────────────────┘
                           │ instructions / status
                           ▼
┌──────────────────────────────────────────────────────────┐
│  FieldAgent Chrome Extension  (MV3)                      │
│                                                          │
│  service-worker.js  — auth, polling, session mgmt       │
│  content.js         — DOM snapshot, fill execution,     │
│                        MutationObserver for multi-step   │
│  sidepanel/         — live task status, manual trigger   │
└──────────────────────────┬───────────────────────────────┘
                           │ fills fields, user reviews & submits
                           ▼
                  Target web page (any site)
```

---

## Data Flow

### Single-page form (happy path)

1. Producer calls `POST /tasks` with task payload.
2. User navigates to the target page in Chrome.
3. Content script fires, sends a DOM snapshot to the service via
   `POST /inspect`.
4. Inspector Agent analyzes the snapshot against the task, returns fill
   instructions: `[{selector_hint, fallback_hint, value, action}, ...]`
5. Extension applies the instructions.
6. User reviews, clicks Submit.
7. Extension detects success (URL change or success indicator), calls
   `POST /tasks/{id}/complete` with the result URL.

### Multi-step form

Steps 3–5 repeat on each page/step. The Inspector Agent's response
includes `expect_next_page: true` when it detects a wizard flow, so the
extension knows to re-inspect after the user navigates forward rather
than treating the task as complete.

---

## Inspector Agent

A LangChain ReAct agent backed by Claude. It receives:

**Input:**
```json
{
  "task": {
    "platform": "facebook",
    "destination": "facebook",
    "caption": "...",
    "image_url": "https://...",
    "link": "https://..."
  },
  "snapshot": {
    "url": "https://www.facebook.com/...",
    "title": "Create Post | Facebook",
    "inputs": [
      {"label": "What's on your mind?", "type": "textarea", "aria_label": "create a post"},
      ...
    ],
    "buttons": [{"text": "Post", "type": "submit"}, ...],
    "headings": [...],
    "platform_hint": "facebook"
  }
}
```

**Output:**
```json
{
  "instructions": [
    {
      "selector_hint": "textarea[aria-label='create a post']",
      "fallback_hint": "main text composer textarea",
      "value": "Caption text...",
      "action": "type"
    }
  ],
  "step_complete": false,
  "expect_next_page": false,
  "notes": "Image must be attached manually — no programmatic attach path"
}
```

The agent uses tools to reason through ambiguous cases (multiple matching
fields, unexpected page state, login wall, etc.) before committing to
instructions.

---

## DOM Snapshot Strategy

The content script sends a *semantic* summary, not raw HTML:

- All `<input>`, `<textarea>`, `<select>` with:
  - `type`, `name`, `id`, `placeholder`, `aria-label`, nearest label text
  - current value (so the agent sees what's already filled)
- Visible buttons with their text
- `<h1>`–`<h3>` headings
- Current URL and `<title>`
- `platform_hint` from `window.location.hostname`

Typical payload: under 2 KB. No private page content, no DOM noise.

---

## Authentication

The extension Options page takes:
- **Service URL** — where the FieldAgent service is running
- **API Key** — generated by the service on first start (printed to stdout)

Stored in `chrome.storage.sync`. The service validates `X-API-Key` on
every request. Keys are seeded from `FIELDAGENT_API_KEYS` in `.env`.

---

## Fill Instruction Execution

The content script tries two resolution strategies per instruction:

1. **Primary** — `selector_hint` as a CSS/attribute selector (e.g.
   `textarea[aria-label="What's on your mind?"]`)
2. **Fallback** — keyword matching against `fallback_hint` across visible
   inputs' labels, placeholders, and ARIA attributes

After resolving the element, it simulates native input events
(`input`, `change`) so React/Vue/Angular state updates fire correctly.

---

## Supported Targets

| Site       | Composer? | URL prefill? | Clipboard assist? | Notes |
|------------|-----------|-------------|------------------|-------|
| Pinterest  | Yes       | Full        | Safety net        | Best case — image, title, description, link via URL params |
| Facebook   | Yes       | Partial     | Caption           | sharer.php opens page; extension fills composer after load |
| Instagram  | No (mobile)| No         | Caption           | Deep link to app + auto-copy caption |
| X/Twitter  | Yes       | Text only   | Safety net        | `intent/tweet?text=` |
| LinkedIn   | Yes       | No          | Caption           | Extension fills composer after navigation |

FieldAgent works on any site with an HTML form — social platforms are
just the first-class targets because they have the highest manual burden.

---

## Phased Rollout

### Phase 1 — Core loop (Pinterest)
- Service with Inspector Agent
- Extension content script and side panel
- Single-step form fill
- Manual `POST /tasks` to trigger

### Phase 2 — Multi-step + more platforms
- MutationObserver re-inspect loop
- Facebook and LinkedIn support
- Side panel live status during multi-step flows

### Phase 3 — Auth + publishing
- API key management UI in extension Options
- Docker packaging for the service
- Chrome Web Store listing

### Phase 4 — Extensibility
- Webhook / SSE callback so producers get notified when a task completes
- Task history and audit log
- Support for file upload fields (media attachment)

---

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Extension | Chrome MV3 | Required for Chrome Web Store; Side Panel API available since Chrome 116 |
| Extension UI | Vanilla JS | No build step for MVP; swap to React/Vite if needed |
| Service | FastAPI (Python) | Async-native, easy LangChain integration, clean OpenAPI docs |
| Agent | LangChain + Claude | Structured output, tool use, reliable JSON extraction |
| Task storage | In-memory → SQLite | Simple for MVP; production swap is one file |
| Auth | API keys | Simple, no OAuth dependency, usable from any HTTP client |

---

## Directory Structure

```
fieldagent/
├── docs/
│   └── PLAN.md               ← this file
├── extension/
│   ├── manifest.json
│   ├── icons/
│   ├── background/
│   │   └── service-worker.js  ← auth, polling, session management
│   ├── content/
│   │   └── content.js         ← DOM snapshot, fill execution
│   ├── sidepanel/
│   │   ├── index.html
│   │   └── panel.js           ← live task status UI
│   └── options/
│       └── index.html         ← service URL + API key settings
├── service/
│   ├── main.py                ← FastAPI app
│   ├── config.py
│   ├── auth.py
│   ├── store.py               ← task store (in-memory, swap for prod)
│   ├── requirements.txt
│   ├── .env.example
│   ├── agents/
│   │   └── inspector.py       ← LangChain Inspector Agent
│   ├── api/
│   │   ├── tasks.py           ← task CRUD
│   │   └── inspect.py         ← DOM snapshot → instructions
│   └── models/
│       └── schemas.py         ← Pydantic models
└── shared/
    └── protocol.md            ← extension ↔ service message format
```
