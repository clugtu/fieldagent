# FieldAgent

[![CI](https://github.com/clugtu/fieldagent/actions/workflows/ci.yml/badge.svg)](https://github.com/clugtu/fieldagent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**An AI agent that fills in web forms — you direct it, you submit.**

FieldAgent is a Chrome extension backed by an AI microservice. You stay
logged into your own accounts and navigate normally. FieldAgent inspects
the current page, figures out which fields need filling and with what,
pre-populates them, and steps aside. You review and click Submit.

---

## Why an agent, not a hardcoded schema

The obvious alternative is a library of platform-specific selectors —
`facebook: { caption: "div[aria-label='...']", ... }` — and for a while
that works. Then Facebook redesigns their composer, the selector breaks,
and nothing fills until someone manually hunts down the new one and ships
a fix. Social platforms redesign frequently and without notice. A selector
library requires constant maintenance just to stand still.

An agent reads the page the same way a person does: it looks at labels,
placeholder text, ARIA attributes, and headings, and figures out what goes
where from context. When the layout changes, the agent adapts without a
code change. It can also handle things a schema can't — asking for
clarification when a page is ambiguous, recognising that it's looking at a
login wall instead of a composer, detecting that a multi-step flow has
moved to the next step.

**What about the platform APIs?**

Official APIs exist for most of these platforms, but they are not designed
for the use case FieldAgent targets. Facebook's Graph API requires a
business verification process, app review, and page admin permissions
before you can post a single thing. Pinterest's API is rate-limited, has
a separate approval tier for write access, and doesn't support all content
types. Instagram's API works through a Facebook Business account and is
similarly restricted. In practice, the full-featured posting experience
these platforms offer to their own logged-in users is simply not available
to third-party developers via API.

FieldAgent operates as the logged-in user, in their own browser, with
their own session — which means it has access to exactly the same
capabilities they do.

---

## How it works

1. A producer (your app, a CLI call, anything) enqueues a task via the
   FieldAgent service API with the content to fill in.
2. You navigate to the target page in Chrome.
3. The extension's content script extracts a semantic DOM snapshot
   (inputs, labels, buttons — not raw HTML) and sends it to the service.
4. The Inspector Agent (LLM-backed) analyzes the snapshot against the
   task and returns structured fill instructions.
5. The extension applies the instructions — fields appear pre-populated.
6. You review, edit if needed, and submit. FieldAgent never clicks Submit.
7. On success, the extension marks the task complete.

Multi-page flows are handled: the extension watches for significant DOM
changes and re-inspects on each new step automatically.

---

## Structure

```
fieldagent/
├── docs/PLAN.md          Full design document
├── extension/            Chrome MV3 extension
│   ├── manifest.json
│   ├── background/       Service worker (auth, task polling, relay)
│   ├── content/          Content script (DOM snapshot, fill execution)
│   ├── sidepanel/        Side panel UI (live task status)
│   └── options/          Settings page (service URL + API key)
├── service/              FastAPI microservice + Inspector Agent
│   ├── main.py
│   ├── agents/           LangChain Inspector Agent (Claude)
│   ├── api/              Task CRUD + inspect endpoint
│   └── models/           Pydantic schemas
└── shared/               Extension ↔ service protocol docs
```

---

## Quick start

### Service

```bash
cd service
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in ANTHROPIC_API_KEY
uvicorn main:app --port 8080 --reload
# A bootstrap API key is printed to stdout on first run
```

### Extension

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. **Load unpacked** → select the `extension/` directory
4. Click the FieldAgent toolbar icon → **Settings** → enter your service URL and API key

---

## API

```
POST /tasks                   Enqueue a task
GET  /tasks/pending           Claim the next pending task (used by the extension)
GET  /tasks/{id}              Get task status
POST /tasks/{id}/complete     Mark a task done with the result URL
POST /inspect                 Submit a DOM snapshot, get fill instructions back
GET  /health                  Health check
```

Authentication: `X-API-Key` header on every request.

---

## Connecting an app

Any app that wants FieldAgent to fill a form just needs to:

1. `POST /tasks` with the task payload (what to fill, on which platform).
2. Tell the user to navigate to that URL.
3. FieldAgent handles the rest.

Poll `GET /tasks/{id}` to find out when it's done and retrieve the result URL.

---

See `docs/PLAN.md` for the full design rationale.
