#!/usr/bin/env bash
# Run from anywhere: kills the uvicorn process on the configured port.
PORT="${PORT:-8080}"
PID=$(lsof -ti tcp:$PORT 2>/dev/null)
if [ -z "$PID" ]; then
  echo "Nothing running on port $PORT"
else
  kill "$PID" && echo "Stopped (port $PORT, PID $PID)"
fi
