# Extension ↔ Service Protocol

All messages between the extension (service worker / content script)
and the FieldAgent service use JSON over HTTPS. The extension never
talks directly to Claude — all AI calls go through the service.

## Extension → Service Worker (chrome.runtime messages)

```
{ type: "GET_PENDING_TASK" }
{ type: "SUBMIT_SNAPSHOT", snapshot: DomSnapshot }
{ type: "COMPLETE_TASK", taskId: string, resultUrl: string }
{ type: "GET_STATUS" }
```

## Service Worker → Content Script (chrome.tabs.sendMessage)

```
{ type: "APPLY_INSTRUCTIONS", instructions: FillInstruction[] }
{ type: "TASK_COMPLETE" }
{ type: "NO_TASK" }
```

## DomSnapshot shape (content.js → service)

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

## FillInstruction shape (service → content.js)

```json
{
  "selector_hint": "textarea[aria-label='create a post']",
  "fallback_hint": "first textarea on page",
  "value": "Caption text here...",
  "action": "type"
}
```

`action` values: `"type"` | `"select"` | `"focus"`

The extension tries `selector_hint` first (a real CSS selector or
attribute selector), falls back to `fallback_hint` (human-readable,
the extension uses its own heuristics to resolve it) if the primary
selector returns no element.
