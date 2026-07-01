#!/usr/bin/env bash
# Run once after: gh auth login
# Creates the FieldAgent GitHub Project, epics (milestones), labels, and
# initial backlog issues, then seeds the project board.
set -euo pipefail

OWNER="clugtu"
REPO="fieldagent"
GH="${GH:-gh}"

echo "→ Creating epic labels..."
$GH label create "epic/core-loop"       --repo $OWNER/$REPO --color "0075ca" --description "End-to-end text fill working" --force
$GH label create "epic/agent"           --repo $OWNER/$REPO --color "7057ff" --description "Bidirectional question/answer flow" --force
$GH label create "epic/media"           --repo $OWNER/$REPO --color "e4e669" --description "File download and attachment" --force
$GH label create "epic/integrations"   --repo $OWNER/$REPO --color "d93f0b" --description "Per-platform support" --force
$GH label create "epic/release"        --repo $OWNER/$REPO --color "0e8a16" --description "Tests, Docker, Web Store" --force
$GH label create "task"                --repo $OWNER/$REPO --color "bfd4f2" --description "Planned work" --force
$GH label create "bug"                 --repo $OWNER/$REPO --color "d73a4a" --description "Something is broken" --force

echo "→ Creating milestones (epics)..."
M1=$($GH api repos/$OWNER/$REPO/milestones -X POST \
  -f title="v0.1 Core Loop" \
  -f description="Text fill working end-to-end on a real page" \
  -f state="open" | jq -r '.number')

M2=$($GH api repos/$OWNER/$REPO/milestones -X POST \
  -f title="v0.2 Bidirectional Agent + Media" \
  -f description="Agent asks questions; files attached automatically" \
  -f state="open" | jq -r '.number')

M3=$($GH api repos/$OWNER/$REPO/milestones -X POST \
  -f title="v0.3 Platform Integrations" \
  -f description="Pinterest, Facebook, LinkedIn working" \
  -f state="open" | jq -r '.number')

M4=$($GH api repos/$OWNER/$REPO/milestones -X POST \
  -f title="v1.0 Release" \
  -f description="Tests, Docker, Chrome Web Store listing" \
  -f state="open" | jq -r '.number')

echo "→ Creating backlog issues..."

create_issue() {
  local title="$1" labels="$2" milestone="$3" body="$4"
  $GH issue create --repo $OWNER/$REPO \
    --title "$title" \
    --label "$labels" \
    --milestone "$milestone" \
    --body "$body"
}

# ── Epic 1: Core Loop ──────────────────────────────────────────────────────
create_issue \
  "Service: verify task lifecycle create → claim → complete end-to-end" \
  "task,epic/core-loop" "$M1" \
  "$(cat <<'EOF'
Smoke-test the task API against a running service instance.

**Done when**
- [ ] POST /tasks creates a task with status pending
- [ ] GET /tasks/pending claims it and flips it to active
- [ ] POST /tasks/{id}/complete marks it done with a result URL
- [ ] CI passes
EOF
)"

create_issue \
  "Inspector graph: analyze → fill path returns instructions for a sample snapshot" \
  "task,epic/core-loop" "$M1" \
  "$(cat <<'EOF'
Write an integration test (real LLM call or a fixture) that runs the graph
against a hand-crafted DOM snapshot and checks that fill instructions come back.

**Done when**
- [ ] run_inspector() returns InspectResponse with status=instructions
- [ ] At least one FillInstruction has a non-empty selector_hint
- [ ] CI passes
EOF
)"

create_issue \
  "Content script: DOM snapshot extraction produces expected shape" \
  "task,epic/core-loop" "$M1" \
  "$(cat <<'EOF'
Load a static HTML fixture in a test harness and verify extractSnapshot()
returns the right inputs/buttons/headings.

**Done when**
- [ ] inputs[] contains all visible input and textarea elements
- [ ] hidden inputs are excluded
- [ ] buttons[] includes text and disabled state
- [ ] CI passes
EOF
)"

create_issue \
  "Content script: applyInstruction fills a text field using nativeSetter" \
  "task,epic/core-loop" "$M1" \
  "$(cat <<'EOF'
Unit-test applyInstruction with action=type against a real DOM element in
jsdom. Confirm the input event fires so React/Vue state updates.

**Done when**
- [ ] Field value is set
- [ ] input and change events fire
- [ ] CI passes
EOF
)"

create_issue \
  "E2E: Pinterest pin composer — title and description pre-filled" \
  "task,epic/core-loop" "$M1" \
  "$(cat <<'EOF'
Manual acceptance test for the first real platform target.

**Steps**
1. Start service locally
2. POST /tasks with a Pinterest payload
3. Open pinterest.com/pin/creation/button/ in Chrome with extension loaded
4. Confirm title and description fields are pre-populated

**Done when**
- [ ] Fields fill without errors in the console
- [ ] Side panel shows active task and last instructions
- [ ] Task can be marked complete with the pin URL
EOF
)"

# ── Epic 2: Bidirectional Agent ────────────────────────────────────────────
create_issue \
  "Graph: ask node sets task to awaiting_input with structured question" \
  "task,epic/agent" "$M2" \
  "$(cat <<'EOF'
Test the ask branch of the graph with a snapshot that has ambiguous fields
(e.g. multiple boards on a Pinterest page).

**Done when**
- [ ] InspectResponse.status == awaiting_input
- [ ] question.text is non-empty and question.options is populated
- [ ] task.status flipped to awaiting_input in store
- [ ] CI passes
EOF
)"

create_issue \
  "Graph: resume_with_answer continues from checkpoint and returns instructions" \
  "task,epic/agent" "$M2" \
  "$(cat <<'EOF'
After an awaiting_input response, call /inspect/respond/{id} with an answer
and confirm the graph resumes and returns instructions.

**Done when**
- [ ] POST /inspect/respond returns status=instructions
- [ ] task.status returns to active
- [ ] CI passes
EOF
)"

create_issue \
  "Side panel: surface agent question with options for user to answer" \
  "task,epic/agent" "$M2" \
  "$(cat <<'EOF'
When InspectResponse.status == awaiting_input, the side panel should show
the question text and clickable option buttons. Clicking one POSTs to
/inspect/respond and re-applies the resulting instructions.

**Done when**
- [ ] Question appears in side panel when task is awaiting_input
- [ ] Clicking an option sends the answer and applies new instructions
- [ ] Side panel returns to normal instructions view after
EOF
)"

# ── Epic 3: Media ──────────────────────────────────────────────────────────
create_issue \
  "Service: /assets/{task_id}/{asset_id} streams bytes from remote URL" \
  "task,epic/media" "$M2" \
  "$(cat <<'EOF'
Test the asset proxy against a real (or mock) remote file URL.

**Done when**
- [ ] GET /assets/{task_id}/{asset_id} returns correct bytes and Content-Type
- [ ] 404 when task or asset_id not found
- [ ] CI passes
EOF
)"

create_issue \
  "Extension: attach_file action injects file via DataTransfer on input[type=file]" \
  "task,epic/media" "$M2" \
  "$(cat <<'EOF'
Unit-test applyFileAttach against a real file input in jsdom.
Service worker FETCH_ASSET can be mocked to return a known base64 payload.

**Done when**
- [ ] input.files[0] matches the expected File object
- [ ] change event fires
- [ ] CI passes
EOF
)"

create_issue \
  "E2E: image attached to Pinterest pin via file input" \
  "task,epic/media" "$M2" \
  "$(cat <<'EOF'
Manual acceptance test for media attachment.

**Done when**
- [ ] Task payload includes a media asset with a real image URL
- [ ] Extension downloads and attaches it to the file input on the pin composer
- [ ] Image appears in the Pinterest preview before user submits
EOF
)"

# ── Epic 4: Platform Integrations ─────────────────────────────────────────
create_issue \
  "Pinterest: board selector — agent asks which board if multiple exist" \
  "task,epic/integrations" "$M3" \
  "$(cat <<'EOF'
When the Pinterest composer shows a board dropdown with multiple options,
the agent should ask the caller which one to select rather than guessing.

**Done when**
- [ ] awaiting_input returned with board options populated from the snapshot
- [ ] Caller answer selects the correct board
EOF
)"

create_issue \
  "Facebook: caption fills in composer, clipboard auto-copy as backup" \
  "task,epic/integrations" "$M3" \
  "$(cat <<'EOF'
Facebook's composer loads dynamically. The content script should fill the
editable div after it appears, with a clipboard copy as fallback if the
selector doesn't resolve.

**Done when**
- [ ] Caption appears in Facebook composer after page load
- [ ] Clipboard contains caption as fallback
- [ ] Side panel step list reflects the multi-step flow
EOF
)"

create_issue \
  "LinkedIn: single-page post composer fill" \
  "task,epic/integrations" "$M3" \
  "$(cat <<'EOF'
LinkedIn's share dialog is a single-step modal. Caption fill only.

**Done when**
- [ ] Caption fills in LinkedIn share dialog
- [ ] Result URL captured after user posts
EOF
)"

# ── Epic 5: Quality & Release ─────────────────────────────────────────────
create_issue \
  "Service: replace in-memory store with SQLite for task persistence" \
  "task,epic/release" "$M4" \
  "$(cat <<'EOF'
Tasks currently live in a dict and are lost on restart. Swap TaskStore
for a SQLite-backed implementation using the same interface.

**Done when**
- [ ] Tasks survive service restart
- [ ] LangGraph MemorySaver swapped for SqliteSaver
- [ ] Existing tests pass
- [ ] CI passes
EOF
)"

create_issue \
  "CI: add pytest suite with mocked LLM responses for graph nodes" \
  "task,epic/release" "$M4" \
  "$(cat <<'EOF'
Add a pytest step to CI. Tests mock the LLM so they run without an API key
and are fast enough to be part of every PR check.

**Done when**
- [ ] pytest step added to ci.yml
- [ ] analyze, fill, ask nodes each have at least one test
- [ ] CI passes
EOF
)"

create_issue \
  "Release: Docker packaging for the service" \
  "task,epic/release" "$M4" \
  "$(cat <<'EOF'
Add a Dockerfile and docker-compose.yml so the service can be run without
a local Python environment.

**Done when**
- [ ] docker compose up starts the service on port 8080
- [ ] Health check passes inside the container
- [ ] README quick-start updated with Docker instructions
EOF
)"

create_issue \
  "Release: Chrome Web Store listing" \
  "task,epic/release" "$M4" \
  "$(cat <<'EOF'
Publish FieldAgent to the Chrome Web Store.

**Done when**
- [ ] Extension icons created (16px, 48px, 128px)
- [ ] Store description, screenshots prepared
- [ ] Extension submitted and approved
EOF
)"

echo ""
echo "→ Creating GitHub Project..."
PROJECT_URL=$($GH project create --owner $OWNER --title "FieldAgent" --format json | jq -r '.url')
PROJECT_NUM=$($GH project list --owner $OWNER --format json | jq ".projects[] | select(.title==\"FieldAgent\") | .number")

echo "→ Adding Status field..."
$GH project field-create $PROJECT_NUM --owner $OWNER \
  --name "Status" \
  --data-type SINGLE_SELECT \
  --single-select-options "Backlog,In Progress,Review,Done"

echo "→ Adding Epic field..."
$GH project field-create $PROJECT_NUM --owner $OWNER \
  --name "Epic" \
  --data-type SINGLE_SELECT \
  --single-select-options "Core Loop,Bidirectional Agent,Media,Platform Integrations,Release"

echo ""
echo "✓ Done. Project: $PROJECT_URL"
echo ""
echo "Next: open the project board and drag issues to the right Epic."
echo "Branch protection:"
echo "  gh api repos/$OWNER/$REPO/branches/master/protection --method PUT \\"
echo "    --field required_status_checks='{\"strict\":true,\"contexts\":[\"Service\",\"Extension\"]}' \\"
echo "    --field enforce_admins=false \\"
echo "    --field required_pull_request_reviews='{\"required_approving_review_count\":0}' \\"
echo "    --field restrictions=null"
