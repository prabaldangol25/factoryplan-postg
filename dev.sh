#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="$ROOT_DIR/.devin/run"
LOG_DIR="$ROOT_DIR/.devin/logs"
PID_FILE="$STATE_DIR/dev.pids"
BACKEND_URL="http://127.0.0.1:8080/api/health"
FRONTEND_URL="http://localhost:5173"

mkdir -p "$STATE_DIR" "$LOG_DIR"

usage() {
  cat <<EOF
Usage: $(basename "$0") [start|stop|restart|status|logs]

Commands:
  start    Start backend and frontend, then open $FRONTEND_URL
  stop     Stop both dev servers
  restart  Stop, then start both dev servers
  status   Show whether the saved PIDs are still running
  logs     Show log file locations

Double-clicking or running without arguments defaults to: start
EOF
}

is_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

load_pids() {
  BACKEND_PID=""
  FRONTEND_PID=""
  if [[ -f "$PID_FILE" ]]; then
    source "$PID_FILE"
  fi
}

save_pids() {
  cat > "$PID_FILE" <<EOF
BACKEND_PID=$BACKEND_PID
FRONTEND_PID=$FRONTEND_PID
EOF
}

kill_pid_tree() {
  local pid="$1"
  local name="$2"

  if ! is_running "$pid"; then
    echo "$name is not running."
    return
  fi

  if command -v taskkill.exe >/dev/null 2>&1; then
    taskkill.exe //PID "$pid" //T //F >/dev/null 2>&1 || kill "$pid" >/dev/null 2>&1 || true
  else
    kill "$pid" >/dev/null 2>&1 || true
  fi

  sleep 1
  if is_running "$pid"; then
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi

  echo "Stopped $name."
}

open_frontend() {
  if command -v cmd.exe >/dev/null 2>&1; then
    cmd.exe //C start "" "$FRONTEND_URL" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$FRONTEND_URL" >/dev/null 2>&1 || true
  elif command -v open >/dev/null 2>&1; then
    open "$FRONTEND_URL" >/dev/null 2>&1 || true
  fi
}

wait_for_url() {
  local url="$1"
  local label="$2"
  local attempts=30

  if ! command -v curl >/dev/null 2>&1; then
    return
  fi

  for ((i = 1; i <= attempts; i++)); do
    if curl --silent --fail "$url" >/dev/null 2>&1; then
      echo "$label is responding."
      return
    fi
    sleep 1
  done

  echo "$label did not respond yet. Check logs if it does not finish starting."
}

start() {
  load_pids

  if is_running "${BACKEND_PID:-}" || is_running "${FRONTEND_PID:-}"; then
    echo "One or both dev servers already appear to be running."
    status
    echo "Use './dev.sh restart' to restart them."
    return
  fi

  if ! command -v cargo >/dev/null 2>&1; then
    echo "cargo was not found on PATH. Install Rust or open a shell where cargo is available."
    exit 1
  fi

  if ! command -v npm >/dev/null 2>&1; then
    echo "npm was not found on PATH. Install Node.js or open a shell where npm is available."
    exit 1
  fi

  if [[ ! -d "$ROOT_DIR/frontend/node_modules" ]]; then
    echo "frontend/node_modules not found; running npm install first."
    (cd "$ROOT_DIR/frontend" && npm install)
  fi

  echo "Starting backend on http://127.0.0.1:8080 ..."
  (cd "$ROOT_DIR/backend" && RUST_LOG="${RUST_LOG:-info}" cargo run > "$LOG_DIR/backend.log" 2>&1) &
  BACKEND_PID=$!

  echo "Starting frontend on $FRONTEND_URL ..."
  (cd "$ROOT_DIR/frontend" && npm run dev -- --host 127.0.0.1 > "$LOG_DIR/frontend.log" 2>&1) &
  FRONTEND_PID=$!

  save_pids

  wait_for_url "$BACKEND_URL" "Backend"
  wait_for_url "$FRONTEND_URL" "Frontend"
  if [[ "${NO_OPEN:-}" != "1" ]]; then
    open_frontend
  fi

  echo
  echo "Started both dev servers."
  echo "Backend log:  $LOG_DIR/backend.log"
  echo "Frontend log: $LOG_DIR/frontend.log"
  echo "Stop both with: ./dev.sh stop"
}

stop() {
  load_pids

  if [[ -z "${BACKEND_PID:-}" && -z "${FRONTEND_PID:-}" ]]; then
    echo "No saved dev server PIDs found."
    return
  fi

  [[ -n "${FRONTEND_PID:-}" ]] && kill_pid_tree "$FRONTEND_PID" "frontend"
  [[ -n "${BACKEND_PID:-}" ]] && kill_pid_tree "$BACKEND_PID" "backend"
  rm -f "$PID_FILE"
}

status() {
  load_pids

  if is_running "${BACKEND_PID:-}"; then
    echo "Backend:  running (PID $BACKEND_PID)"
  else
    echo "Backend:  stopped"
  fi

  if is_running "${FRONTEND_PID:-}"; then
    echo "Frontend: running (PID $FRONTEND_PID)"
  else
    echo "Frontend: stopped"
  fi
}

logs() {
  echo "Backend log:  $LOG_DIR/backend.log"
  echo "Frontend log: $LOG_DIR/frontend.log"
}

case "${1:-start}" in
  start) start ;;
  stop) stop ;;
  restart) stop; start ;;
  status) status ;;
  logs) logs ;;
  -h|--help|help) usage ;;
  *) usage; exit 1 ;;
esac
