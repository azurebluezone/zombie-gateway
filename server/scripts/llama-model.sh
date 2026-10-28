#!/usr/bin/env bash
# llama.cpp model supervisor for the local GGUF files.
#
# Why a script instead of a unit: the model is swapped by hand (different GGUF,
# different ctx), and a start/stop script keeps that reversible in one command.
# The process still runs under systemd --user when started from
# llama-model.service; this file is the single implementation both paths use.
#
# Load mode is `mmap` on purpose: the weights stay a memory-mapped file, so the
# kernel pages them in on first use and can drop clean pages under pressure
# instead of swapping. `--mlock` is opt-in (LLAMA_MLOCK=1) because pinning 1 GiB
# on a 16 GiB box is a policy decision, not a default.
#
# Every line the server prints goes to logs/llama-server.log; the per-request
# JSONL stream (--log-jsonl) goes to logs/llama-server.jsonl.

set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${LLAMA_LOG_DIR:-$SERVER_DIR/logs}"

MODEL="${LLAMA_MODEL:-/home/sahon/.cache/huggingface/hub/models--mradermacher--Llama-3.2-1B-Instruct-abliterated-GGUF/snapshots/becf36858832feddfea0ace2fabf791797571999/Llama-3.2-1B-Instruct-abliterated.Q5_K_S.gguf}"
BIN="${LLAMA_SERVER_BIN:-/home/sahon/src/llama.cpp/build/bin/llama-server}"
LIB_DIR="$(dirname "$BIN")"

HOST="${LLAMA_HOST:-127.0.0.1}"
PORT="${LLAMA_PORT:-8080}"
CTX="${LLAMA_CTX:-4096}"
THREADS="${LLAMA_THREADS:-4}"
ALIAS="${LLAMA_ALIAS:-llama-3.2-1b-abliterated}"
LOAD_MODE="${LLAMA_LOAD_MODE:-mmap}"
MLOCK="${LLAMA_MLOCK:-0}"

PID_FILE="$LOG_DIR/llama-server.pid"
LOG_FILE="$LOG_DIR/llama-model.log"      # supervisor lines + crash output
JSONL_FILE="$LOG_DIR/llama-server.jsonl" # every line llama-server prints
BASE_URL="http://$HOST:$PORT"
HEALTH_URL="$BASE_URL/health"
START_TIMEOUT="${LLAMA_START_TIMEOUT:-180}"

mkdir -p "$LOG_DIR"

log() { printf '%s %s\n' "$(date -Is)" "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

health_ok() {
  curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1
}

read_pid() {
  [ -s "$PID_FILE" ] || return 1
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  printf '%s' "$pid"
}

wait_health() {
  local started=$SECONDS pid
  pid="$(read_pid || true)"
  while (( SECONDS - started < START_TIMEOUT )); do
    if health_ok; then
      printf 'healthy after %ss (pid %s)\n' "$((SECONDS - started))" "${pid:-?}"
      return 0
    fi
    if [ -n "${pid:-}" ] && ! kill -0 "$pid" 2>/dev/null; then
      printf 'server exited during load\n' >&2
      tail -n 25 "$JSONL_FILE" >&2 || true
      return 1
    fi
    sleep 1
  done
  printf 'health check timed out after %ss\n' "$START_TIMEOUT" >&2
  tail -n 25 "$JSONL_FILE" >&2 || true
  return 1
}

cmd_start() {
  [ -x "$BIN" ] || die "llama-server not executable: $BIN"
  [ -f "$MODEL" ] || die "model not found: $MODEL"

  if health_ok; then
    printf 'already running: %s (pid %s)\n' "$BASE_URL" "$(read_pid || echo '?')"
    return 0
  fi
  if pid="$(read_pid)"; then
    printf 'pid %s alive but not healthy yet; waiting\n' "$pid"
    wait_health
    return $?
  fi

  local extra=()
  [ "$MLOCK" = "1" ] && extra+=(--mlock)
  [ -n "${LLAMA_EXTRA_ARGS:-}" ] && read -r -a _extra <<<"$LLAMA_EXTRA_ARGS" && extra+=("${_extra[@]}")

  log "starting $BIN" >>"$LOG_FILE"
  LD_LIBRARY_PATH="$LIB_DIR${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
  setsid "$BIN" \
    --model "$MODEL" \
    --alias "$ALIAS" \
    --host "$HOST" --port "$PORT" \
    --ctx-size "$CTX" \
    --threads "$THREADS" --threads-batch "$THREADS" \
    --parallel 1 \
    --load-mode "$LOAD_MODE" \
    --jinja --no-webui --metrics \
    --log-jsonl \
    "${extra[@]}" \
    >>"$JSONL_FILE" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" >"$PID_FILE"
  printf 'started pid %s, waiting for %s\n' "$pid" "$HEALTH_URL"
  wait_health || return 1
}

cmd_stop() {
  local pid
  if ! pid="$(read_pid)"; then
    rm -f "$PID_FILE"
    printf 'not running\n'
    return 0
  fi
  printf 'stopping pid %s\n' "$pid"
  kill -TERM "$pid" 2>/dev/null || true
  local waited=0
  while kill -0 "$pid" 2>/dev/null && (( waited < 30 )); do
    sleep 1
    waited=$((waited + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    printf 'still alive after %ss, sending SIGKILL\n' "$waited"
    kill -KILL "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  printf 'stopped\n'
}

cmd_status() {
  local pid
  if pid="$(read_pid)"; then
    printf 'pid:      %s\n' "$pid"
  else
    printf 'pid:      none\n'
  fi
  if health_ok; then
    printf 'health:   up (%s)\n' "$HEALTH_URL"
    curl -fsS --max-time 3 "$BASE_URL/props" 2>/dev/null | python3 -c '
import json, sys
p = json.load(sys.stdin)
g = p.get("default_generation_settings") or {}
print("model:   ", p.get("model_path", "?").split("/")[-1])
print("n_ctx:   ", g.get("n_ctx", "?"))
print("slots:   ", p.get("total_slots", "?"))
' || true
    printf 'url:      %s\n' "$BASE_URL"
    printf 'models:   %s\n' "$(curl -fsS --max-time 3 "$BASE_URL/v1/models" 2>/dev/null | python3 -c 'import json,sys;print(", ".join(m["id"] for m in json.load(sys.stdin).get("data",[])))' 2>/dev/null || echo '?')"
    if [ -n "${pid:-}" ]; then
      printf 'rss:      %s\n' "$(ps -o rss= -p "$pid" | awk '{printf "%.0f MiB", $1/1024}')"
      local resolved
      resolved="$(readlink -f "$MODEL" 2>/dev/null || printf '%s' "$MODEL")"
      if grep -qF -- "$resolved" "/proc/$pid/maps" 2>/dev/null || grep -q "hub/blobs/" "/proc/$pid/maps" 2>/dev/null; then
        printf 'mmap:     yes (gguf mapped into the process)\n'
      else
        printf 'mmap:     no\n'
      fi
    fi
  else
    printf 'health:   down (%s)\n' "$HEALTH_URL"
    printf 'url:      %s\n' "$BASE_URL"
  fi
  printf 'log:      %s\n' "$LOG_FILE"
  printf 'requests: %s\n' "$JSONL_FILE"
}

cmd_logs() {
  local n="${1:-40}"
  printf '== supervisor (%s) ==\n' "$LOG_FILE"
  tail -n 10 "$LOG_FILE" 2>/dev/null || true
  printf '== llama-server (%s) ==\n' "$JSONL_FILE"
  tail -n "$n" "$JSONL_FILE" 2>/dev/null || true
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status) cmd_status ;;
  logs) shift; cmd_logs "${1:-40}" ;;
  url) printf '%s\n' "$BASE_URL" ;;
  *)
    cat >&2 <<EOF
usage: $(basename "$0") {start|stop|restart|status|logs [n]|url}

env overrides:
  LLAMA_MODEL      $MODEL
  LLAMA_SERVER_BIN $BIN
  LLAMA_PORT       $PORT
  LLAMA_CTX        $CTX
  LLAMA_THREADS    $THREADS
  LLAMA_LOAD_MODE  $LOAD_MODE   (mmap | mmap+mlock | none)
  LLAMA_MLOCK      0
  LLAMA_LOG_DIR    $LOG_DIR
EOF
    exit 2
    ;;
esac
