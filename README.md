# FieldAgent

AI-assisted browser form filling for social media posting.

FieldAgent is a Chrome extension + AI microservice. You stay logged into
your own accounts and navigate normally — FieldAgent inspects the page,
pre-populates the fields, and you review and publish.

## How it works

1. Your app (or Miniforge) enqueues a posting task via the FieldAgent service API.
2. The Chrome extension detects the pending task when you open the target platform.
3. The extension sends a semantic DOM snapshot (labels, inputs, buttons) to the service.
4. An LLM-backed Inspector Agent analyzes the snapshot and returns fill instructions.
5. The extension applies the instructions — fields are pre-populated for you to review.
6. You review, optionally edit, then click Publish. FieldAgent never submits for you.
7. The extension detects the result and marks the task complete.

## Structure

```
fieldagent/
├── docs/PLAN.md          Full design document
├── extension/            Chrome MV3 extension
│   ├── manifest.json
│   ├── background/       Service worker (auth, polling, relay)
│   ├── content/          Content script (DOM snapshot, fill execution)
│   ├── sidepanel/        Side panel UI (live task status)
│   └── options/          Settings page (service URL + API key)
├── service/              FastAPI microservice + Inspector Agent
│   ├── main.py
│   ├── agents/           LangChain Inspector Agent (Claude)
│   ├── api/              Task CRUD + inspect endpoint
│   └── models/           Pydantic schemas
└── shared/               Protocol docs
```

## Quick start

### Service

```bash
cd service
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in ANTHROPIC_API_KEY
uvicorn main:app --port 8080 --reload
# A bootstrap API key prints to stdout on first run
```

### Extension

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. "Load unpacked" → select the `extension/` directory
4. Click the FieldAgent icon → open Settings → enter your service URL and API key

## Integration with Miniforge

Miniforge calls `POST /tasks` on the FieldAgent service when the user
clicks "Post Manually" on a Meta or Pinterest post. FieldAgent also
exposes MCP-compatible tool endpoints so the Miniforge agent can trigger
posting flows as part of longer automation chains.

See `docs/PLAN.md` for the full design.
