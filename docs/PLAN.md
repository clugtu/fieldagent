# FieldAgent — Design Plan

## What It Is

FieldAgent is a Chrome extension + AI microservice that automates the
mechanical parts of posting content to social platforms. The user stays
logged into their own accounts, navigates normally, and reviews before
submitting — FieldAgent just fills in the fields.

It is designed to be published and used independently of Miniforge, but
integrates naturally as a node in the Miniforge multi-agent architecture:
Miniforge can enqueue tasks for FieldAgent to execute, and FieldAgent
reports results back.

---

## The Two-Word Name

- **Field agent** — an operative working out in the world, navigating
  unfamiliar terrain, executing missions from HQ
- **Field agent** — an AI agent that works in form *fields* on web pages

---

## Core Principles

1. **The extension is an actuator, not a brain.** It extracts DOM state
   and applies instructions. All reasoning lives in the service.
2. **The service hosts the actual agent.** An LLM-backed agent inspects
   DOM snapshots, decides what to fill and how, handles unexpected states.
3. **The user always commits.** FieldAgent pre-fills; the user reviews and
   clicks Publish / Next / Submit. No autonomous posting.
4. **Generic by design.** The service knows nothing about specific
   platforms at the code level. The agent figures out what's on screen and
   adapts. Brittle hardcoded selectors are the fallback, not the strategy.
5. **Publishable standalone.** Anyone with an account on any platform and
   an API key can use FieldAgent without Miniforge.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Miniforge (or any task producer)                                │
│  POST /tasks  →  FieldAgent Service                              │
└──────────────────────────┬───────────────────────────────────────┘
                           │ enqueue task
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  FieldAgent Service  (FastAPI + LangChain agent)                 │
│                                                                  │
│  • Task queue  (pending → active → complete)                     │
│  • Inspector Agent  — receives DOM snapshots, returns fill       │
│    instructions.  Multi-step aware: knows whether the current    │
│    page is step N of M, and what to expect next.                 │
│  • SSE / WebSocket channel  — pushes instructions to extension   │
│    in real time without polling                                   │
└──────────────────────────┬───────────────────────────────────────┘
                           │ instructions / status
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│  FieldAgent Chrome Extension  (MV3)                              │
│                                                                  │
│  service-worker.js  — auth, task polling, session management    │
│  content.js         — DOM snapshot extraction, fill execution,  │
│                        MutationObserver for multi-step detection │
│  sidepanel/         — live task status UI, manual re-inspect     │
└──────────────────────────┬───────────────────────────────────────┘
                           │ fills fields, user reviews & submits
                           ▼
              facebook.com / instagram.com / pinterest.com
```

---

## Data Flow

### Happy path (single-page form)

1. Miniforge user clicks "Post Manually" for a Meta post.
2. Miniforge calls `POST /tasks` on FieldAgent Service with the task
   payload (platform, caption, image URL, link, destination).
3. Miniforge opens the social platform in a new tab (or user navigates
   there).
4. Extension content script fires on page load, sends a DOM snapshot to
   the service via `POST /inspect`.
5. Inspector Agent analyzes the snapshot against the pending task, returns
   fill instructions: `[{selector_hint, value, action}, ...]`.
6. Extension applies the instructions (types into inputs, selects options).
7. User reviews, clicks Publish.
8. Extension detects page change (success URL or "post live" indicator),
   calls `POST /tasks/{id}/complete` with the result URL.
9. Service notifies Miniforge (webhook or the next poll).

### Multi-step flow

Steps 4–6 repeat on each new page. The Inspector Agent's response
includes `step_complete: true/false` and `expect_next_page: true/false`
so the extension knows to re-inspect after the user navigates forward
rather than considering the task done.

---

## Inspector Agent

The agent is a LangChain ReAct agent backed by Claude. It receives:

```json
{
  "task": {
    "platform": "facebook",
    "destination": "facebook",
    "caption": "...",
    "image_url": "https://...",
    "link": "https://...",
    "step_hint": null
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

It returns:

```json
{
  "instructions": [
    {
      "selector_hint": "textarea with label \"What's on your mind?\"",
      "value": "The full caption text...",
      "action": "type"
    }
  ],
  "step_complete": false,
  "expect_next_page": false,
  "notes": "Image must be attached manually — no programmatic attach available"
}
```

The agent uses tool calls to reason through ambiguous cases (multiple
matching fields, unexpected page state, login wall detected, etc.) before
committing to instructions.

---

## Extension — DOM Snapshot Strategy

Rather than sending raw HTML (noisy, leaks content, huge), content.js
extracts a semantic summary:

- All `<input>`, `<textarea>`, `<select>` elements with their:
  - `type`, `name`, `id`, `placeholder`, `aria-label`, `aria-describedby`
  - nearest visible `<label>` text
  - current value (so the agent knows what's already filled)
- Visible `<button>` and `<a role="button">` with their text
- `<h1>`–`<h3>` headings
- Current URL and `<title>`
- A `platform_hint` derived from `window.location.hostname`

This keeps the payload small (<2KB typically), avoids sending private
page content the agent doesn't need, and gives the agent everything
necessary to identify fields semantically.

---

## Authentication

The extension has an Options page where the user enters:
- **Service URL** — their FieldAgent service endpoint
  (e.g. `https://fieldagent.example.com` or `http://localhost:8080`)
- **API Key** — generated by the service on first connect

Stored in `chrome.storage.sync` so settings follow the user across
devices. The service issues API keys via `POST /auth/keys` (protected by
an initial setup token set in the service's environment).

For Miniforge integration, Miniforge reads the service URL from its own
config and uses a server-to-server API key (never exposed to the browser).

---

## Multi-Agent Integration with Miniforge

FieldAgent Service exposes an MCP-compatible tool surface so the
Miniforge main agent can call it directly:

- `fieldagent_enqueue_task(platform, payload)` — submit a posting task
- `fieldagent_get_task_status(task_id)` — poll result
- `fieldagent_list_tasks(status?)` — see queue

This means the Miniforge agent can say "post this caption to Facebook"
as part of a longer chain (e.g. after publishing on Cults3D) without
the user having to manually trigger the flow from the package panel.

---

## Platforms

| Platform  | Web composer? | URL prefill? | Clipboard strategy | Notes |
|-----------|--------------|-------------|-------------------|-------|
| Pinterest | Yes          | Yes (full)  | Redundant safety net | Best case — image, title, description, link all via URL params |
| Facebook  | Yes          | Partial     | Caption auto-copied | sharer.php opens page; extension fills text composer after page loads |
| Instagram | No (mobile)  | No          | Caption auto-copied | Extension can't help much; opens phone deep link + copies caption |
| X/Twitter | Yes          | Yes (text)  | Safety net | `twitter.com/intent/tweet` supports `text` param |
| LinkedIn  | Yes          | No          | Caption auto-copied | Extension fills the composer after page load |

Pinterest and X are the highest-fidelity targets. Facebook and LinkedIn
are valuable but require the extension to fill after navigation. Instagram
is the most limited.

---

## Phased Rollout

### Phase 1 — Pinterest (prove the loop)
- Service with Inspector Agent
- Extension content script on pinterest.com
- Single-step form fill
- Manual `POST /tasks` to trigger

### Phase 2 — Facebook + LinkedIn
- Multi-step support (MutationObserver + re-inspect loop)
- Side panel UI for live status
- Miniforge integration (write task from package panel)

### Phase 3 — Auth + Publishing
- API key management UI in extension Options
- Service deployment (Docker + environment config)
- Chrome Web Store listing

### Phase 4 — Full multi-agent integration
- MCP tool surface on the service
- Miniforge agent can call FieldAgent as part of chains
- Task history + audit log

---

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Extension | Chrome MV3 | Required for Chrome Web Store; Side Panel API (Chrome 116+) |
| Extension UI | Vanilla JS + CSS | No build step needed for MVP; swap to React/Vite later |
| Service | FastAPI (Python) | Consistent with Miniforge; async-native; easy LangChain integration |
| Agent | LangChain + Claude | Consistent with Miniforge agent architecture |
| Task storage | In-memory + SQLite | Simple for MVP; swap to Redis/Postgres for production |
| Auth | API keys (HMAC-signed) | Simple, publishable, no OAuth dependency |

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
│   │   └── service-worker.js  ← auth, polling, session
│   ├── content/
│   │   └── content.js         ← DOM snapshot, fill execution
│   └── sidepanel/
│       ├── index.html
│       └── panel.js           ← live task status UI
├── service/
│   ├── main.py                ← FastAPI app
│   ├── requirements.txt
│   ├── .env.example
│   ├── agents/
│   │   └── inspector.py       ← LangChain Inspector Agent
│   ├── api/
│   │   ├── tasks.py           ← task CRUD + status
│   │   └── inspect.py         ← DOM snapshot → instructions
│   └── models/
│       └── schemas.py         ← Pydantic models
└── shared/
    └── protocol.md            ← extension↔service message format
```
