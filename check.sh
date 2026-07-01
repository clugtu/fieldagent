#!/usr/bin/env bash
# Run the full CI pipeline locally before pushing.
# Must pass before any git push.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

run() {
  local label="$1"; shift
  printf "  %-45s" "$label"
  if "$@" > /tmp/check-out 2>&1; then
    echo "✓"
    ((PASS++)) || true
  else
    echo "✗"
    cat /tmp/check-out
    ((FAIL++)) || true
  fi
}

echo
echo "── Service ───────────────────────────────────────────"
cd "$ROOT"
source service/.venv/bin/activate

run "ruff lint"           ruff check service/
run "ruff format"         ruff format --check service/
run "import check"        env PYTHONPATH=. ANTHROPIC_API_KEY=placeholder FIELDAGENT_API_KEYS=placeholder \
                            python -c "from service.main import app; print('OK')"
run "pytest"              env PYTHONPATH=. FIELDAGENT_API_KEYS=test-key \
                            pytest service/tests/ -q

echo
echo "── Extension ─────────────────────────────────────────"
cd "$ROOT/extension"

run "jest"     npm test --silent
run "manifest valid"      python3 - <<'EOF'
import json
with open('manifest.json') as f:
    m = json.load(f)
assert m['manifest_version'] == 3
assert 'background' in m
assert 'content_scripts' in m
print('OK')
EOF

cd "$ROOT"
echo
if [ "$FAIL" -eq 0 ]; then
  echo "All checks passed ($PASS/$((PASS+FAIL))) — safe to push."
else
  echo "$FAIL check(s) failed. Fix before pushing."
  exit 1
fi
