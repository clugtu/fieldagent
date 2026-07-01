# FieldAgent — Work Breakdown Structure

## Structure

- **Epics** → GitHub Milestones (`v0.1`, `v0.2`, `v0.3`, `v1.0`)
- **Stories** → GitHub Issues (labelled with `epic/*`)
- **Tasks** → Markdown checklist inside each issue

Each story is independently shippable: it can be merged to master with CI
green without depending on stories in other epics that haven't landed yet.

---

## Epic 1 — Core Loop `v0.1`

**Goal:** Text fill working end-to-end on a real page.

Most of this is already scaffolded. The work is connecting the pieces and
verifying they work together, not writing significant new code.

| Story | Area |
|---|---|
| Verify task lifecycle: create → claim → complete | service |
| Inspector graph: analyze → fill returns instructions for a sample snapshot | agent |
| Content script: DOM snapshot extraction produces expected shape | extension |
| Content script: applyInstruction fills a text field, events fire | extension |
| **E2E: Pinterest pin composer — title and description pre-filled** | e2e |

The E2E story is the acceptance test for the epic. Everything before it
are the unit pieces. Done when a real Pinterest page fills automatically.

---

## Epic 2 — Bidirectional Agent + Media `v0.2`

**Goal:** Agent can ask questions and accept answers; files attach automatically.

These two can be developed in parallel once Epic 1 closes.

### Bidirectional Agent

| Story | Area |
|---|---|
| Graph: ask node sets task to awaiting_input with structured question | agent |
| Graph: resume_with_answer continues from checkpoint | agent |
| Side panel: surface question with options, send answer on click | extension |

### Media

| Story | Area |
|---|---|
| Service: /assets proxy streams bytes from remote URL | service |
| Extension: attach_file injects file via DataTransfer on input[type=file] | extension |
| **E2E: image attached to Pinterest pin via file input** | e2e |

---

## Epic 3 — Platform Integrations `v0.3`

**Goal:** Pinterest, Facebook, and LinkedIn each working with their specific quirks.

Pinterest is the highest fidelity (URL prefill). Facebook requires multi-step
handling and clipboard fallback. LinkedIn is a simpler single-page modal.

| Story | Area |
|---|---|
| Pinterest: board selector — agent asks which board if multiple exist | agent |
| Facebook: caption fills in composer, clipboard auto-copy as backup | extension |
| LinkedIn: single-page post composer fill | extension |

---

## Epic 4 — Quality & Release `v1.0`

**Goal:** Tested, packaged, published.

| Story | Area |
|---|---|
| Service: replace in-memory store with SQLite | service |
| CI: pytest suite with mocked LLM responses for graph nodes | ci |
| Release: Docker packaging for the service | infra |
| Release: Chrome Web Store listing | release |

---

## Workflow

```
Plan → open issue from backlog (task template)
Build → branch off master: feat/issue-N-short-description
Ship → PR with "Closes #N", CI must be green to merge
Done → issue auto-closes on merge
Bug found → open bug issue (bug template), prioritise into next sprint
```

Every commit that touches a story should reference its issue number in the
message (`#N`). Every PR closes exactly one issue.
