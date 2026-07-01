#!/usr/bin/env bash
# Run from the service/ directory: ./start.sh
set -euo pipefail
cd "$(dirname "$0")"
source .venv/bin/activate
PYTHONPATH=.. uvicorn main:app --port "${PORT:-8080}"
