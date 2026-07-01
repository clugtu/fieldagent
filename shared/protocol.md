# Extension ↔ Service Protocol

All messages between the extension and the FieldAgent service use JSON
over HTTPS. The extension never calls Claude directly.

## Content script → Service worker (chrome.runtime messages)

```
{ type: "SNAPSHOT_READY", snapshot: DomSnapshot }
{ type: "FETCH_ASSET", taskId: string, assetId: string }
{ type: "TASK_COMPLETE", resultUrl: string }
{ type: "GET_ACTIVE_TASK" }
{ type: "CLEAR_TASK" }
```

## Service worker → Content script (chrome.tabs.sendMessage)

```
{ type: "INSPECT_NOW" }
```

## Service worker → Side panel (chrome.runtime.sendMessage)

```
{ type: "TASK_ACQUIRED", task: Task }
{ type: "INSTRUCTIONS_UPDATE", payload: InspectResponse }
{ type: "TASK_DONE", taskId: string }
```

---

## DomSnapshot (content script → service)

```json
{
  "url": "https://www.facebook.com/...",
  "title": "Create Post | Facebook",
  "platform_hint": "facebook",
  "inputs": [
    {
      "tag": "textarea",
      "type": null,
      "name": "",
      "id": "post-composer",
      "placeholder": "What's on your mind?",
      "aria_label": "create a post",
      "label_text": "",
      "current_value": ""
    }
  ],
  "buttons": [
    { "text": "Post", "type": "submit", "disabled": false }
  ],
  "headings": ["Create post"],
  "selects": []
}
```

---

## InspectResponse (service → service worker → content script / side panel)

Three possible `status` values:

### "instructions" — agent produced fill instructions

```json
{
  "task_id": "...",
  "status": "instructions",
  "instructions": [
    {
      "selector_hint": "textarea[aria-label='create a post']",
      "fallback_hint": "main text composer",
      "value": "Caption text...",
      "action": "type",
      "asset_id": null
    },
    {
      "selector_hint": "input[type='file']",
      "fallback_hint": "file upload input",
      "value": "",
      "action": "attach_file",
      "asset_id": "uuid-of-the-asset"
    }
  ],
  "step_complete": false,
  "expect_next_page": false,
  "notes": ""
}
```

`action` values: `"type"` | `"select"` | `"attach_file"` | `"focus"`

For `attach_file`, the extension calls `FETCH_ASSET` to the service worker,
which proxies `/assets/{task_id}/{asset_id}` and returns base64 bytes.
The content script builds a `File` via `DataTransfer` and sets it on the
`<input type="file">`.

### "awaiting_input" — agent needs a question answered

```json
{
  "task_id": "...",
  "status": "awaiting_input",
  "instructions": [],
  "question": {
    "question_id": "...",
    "text": "Which Pinterest board should this pin go to?",
    "options": ["Fantasy Minis", "Horror Minis", "All Minis"],
    "context": "Three boards were found on the page."
  }
}
```

The side panel surfaces the question. The **caller** (any connected app)
answers via `POST /inspect/respond/{task_id}` with `{ "answer": "..." }`.
The graph resumes and returns a new `InspectResponse`.

### "complete" — agent detected a success/confirmation state

```json
{
  "task_id": "...",
  "status": "complete",
  "step_complete": true,
  "notes": "Page title changed to 'Pin published'. Task can be marked complete."
}
```

---

## Media asset flow

```
Caller   →  POST /tasks  (payload includes media[].url)
Service  →  stores task, asset URLs accessible at /assets/{task_id}/{asset_id}
Extension → content script detects attach_file instruction
          → sends FETCH_ASSET to service worker
Service worker → GET /assets/{task_id}/{asset_id} (proxied, authenticated)
               → returns { base64, mimeType, filename }
Content script → builds File via DataTransfer, sets on <input type="file">
```

---

## Bidirectional question flow

```
Extension   →  POST /inspect  (snapshot)
Service     →  graph analyze node decides it needs clarification
            →  returns { status: "awaiting_input", question: {...} }
Side panel  →  surfaces question to user or calling agent
Caller      →  POST /inspect/respond/{task_id}  { answer: "..." }
Service     →  graph resumes from checkpoint, re-evaluates with answer
            →  returns { status: "instructions", instructions: [...] }
Extension   →  applies instructions
```
