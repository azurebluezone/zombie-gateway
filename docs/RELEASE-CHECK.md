# Release check — automated gate

What this file is: the evidence behind the "tested" column of the status tables.
Every number here was produced by a command run on this machine on 2026-10-27;
an item without a command and an output is `UNVERIFIED`.

## 1. Commands

```bash
cd server
npm run typecheck        # tsc --noEmit
npm test                 # node --test test/*.test.ts
```

Measured 2026-10-27 (Node 24.19.0, Ubuntu, 4 cores):

| Check | Result |
| --- | --- |
| `tsc --noEmit` | exit 0 |
| `npm test` | `tests 53 ` · `pass 53 ` · `fail 0` |

Suite split: sanitizer 24, behaviour layer 13, integration 18 (the
Unix-socket and HTTPS cases were added last).
The script is `node --test test/*.test.ts`: naming the files keeps the harness
(`test/fixture.ts`) out of the run, where it would otherwise be reported as one
more passing "test".

```
ℹ tests 53
ℹ pass 53
ℹ fail 0
```

## 2. Integration suite

Files: `server/test/fixture.ts` (an upstream double plus a spawned gateway),
`server/test/gateway.test.ts` (the cases). The gateway is the real entry point
(`node src/index.ts`) with a temporary database and log per case; no test-only
code path exists inside `src/`.

| Case | Asserts | What it would catch |
| --- | --- | --- |
| health | 200, `status:"ok"`, identity headers present | boot regression, missing identity |
| catalogue | `provider/model` id, engine `context_length`, `completion`+declared caps | model-id drift, lost capability |
| non-stream chat | completion body, `usage`, `x-context-limit`, `x-policy` shape | broken JSON path, missing ledger headers |
| stream chat | `text/event-stream`, exactly one `data: [DONE]`, frames forwarded, usage frame | duplicated terminator, swallowed chunks |
| upstream 500 | status 500, code `internal_error`, message `fixture exploded` | envelope mapping, message loss |
| socket inactivity | 504 `provider_timeout` (`CP_FIX_TIMEOUT_MS=1000`) | hung upstream never timing out |
| unreachable provider | 502 `provider_unreachable` | connect errors leaking as 500 |
| client abort | gateway tears down the upstream stream within 4 s | upstream work continuing after the client left |
| body limit | 413 with `exceeds 512 bytes` | silent truncation |
| prompt shutdown | SIGTERM with an idle keep-alive socket returns in < 1500 ms | shutdown waiting on keep-alive |
| metrics panel shutdown | WebSocket gets close frame `1001` before the wire drops | panels treating a clean stop as a crash |
| admin auth | 401 anonymous, 200 with `x-admin-token` | admin surface open by accident |
| admin mutation | create 201 → disable 200 → list shows disabled → purge 200 → gone | registry/DB divergence |
| upstream dies mid-stream | 200, one error frame `code:"provider_stream_error"`, **no** `[DONE]` | a truncated answer presented as complete |
| upstream body stops early (non-stream) | 502 `provider_stream_error`, message names the provider | half a JSON body surfaced as a parse error |
| `/v1/messages` interrupted stream | `event: error` with the same message, no `message_stop` | Anthropic clients appending an error to the answer |

Measured per-case wall clock (integration file, one run):

```
✔ health reports identity and counts (399ms)
✔ catalogue qualifies the model id and keeps the engine's context length (358ms)
✔ non-stream chat returns the completion and the ledger headers (359ms)
✔ stream chat forwards SSE frames and one terminator (346ms)
✔ an upstream 500 keeps the status, the code and the upstream message (344ms)
✔ socket inactivity is a 504 provider_timeout (1341ms)
✔ an unreachable provider is a 502 provider_unreachable (344ms)
✔ a client abort tears down the upstream stream (372ms)
✔ an upstream that dies mid-stream ends with a provider_stream_error frame (395ms)
✔ a non-stream body that stops early is a 502 provider_stream_error, not truncated JSON (392ms)
✔ /v1/messages reports an interrupted upstream as an error event, not a completion (398ms)
✔ a body over the limit is a 413, not a silent truncation (335ms)
✔ shutdown is prompt even with an idle keep-alive connection (334ms)
✔ a metrics panel gets a 1001 close frame on shutdown (354ms)
✔ admin auth is one switch: 401 without the token, 200 with it (358ms)
✔ admin can create, toggle and purge a provider without a restart (360ms)
```

Each case spawns a gateway (process start ≈ 330 ms), so that number is the
floor, not the request latency. The 1348 ms timeout case is the fixture's
1500 ms stall cut by a 1000 ms socket timeout: the floor is the configured
timeout, not the gateway's speed.

## 3. Failure injection

The fixture chooses behaviour from a marker inside the user message, so no
gateway code is test-aware:

| Marker | Upstream does |
| --- | --- |
| `MODE:500` | returns HTTP 500 with `{"error":{"message":"fixture exploded"}}` |
| `MODE:SLOW` | stalls 1500 ms before answering |
| `MODE:ABORT` | streams one chunk, then reports when the gateway closes the socket |
| `MODE:PREMATURE` | streams one chunk, then destroys the socket mid-frame; non-stream sends half a JSON body |

What the gateway does with it: the stream ends with one error frame carrying
`code: "provider_stream_error"` and the provider's name, and no `[DONE]`. A
terminator would tell the client the answer was complete; it was not. The
non-stream path answers 502 with the same code, because "unexpected end of JSON"
describes the parser, not the cause. `/v1/messages` sends the Anthropic-shaped
`event: error` frame for the same reason.

## 4. Shutdown defect found by the suite

First run of the client-abort case took **3442 ms** while the gateway log showed
the request dying at `durationMs: 20`. The delay was not request cleanup:

```
gateway.stop() took 3003 ms
...
{"level":"warn","event":"gateway.force_close","connections":1,
 "peers":[{"remote":"127.0.0.1:54572","destroyed":false,"readable":true,"writable":true}]}
```

Cause: after the client aborted, its HTTP pool opened **one more TCP connection
and sent nothing on it**. That silent socket is neither "in flight" nor
recognised as idle by `server.closeIdleConnections()`, so `server.close()`
waited for the force-close timer.

Fix (`server/src/index.ts`): two sets are tracked per connection — `openSockets`
and `busySockets` (incremented on `request`, released on `finish`/`close`).
Shutdown destroys every open socket that never entered a request before falling
back to `closeIdleConnections()` and the 3 s grace timer. In-flight streams keep
their grace period.

A second candidate — destroying the response socket from the `close` handler —
was tried and discarded. The trace showed the socket was already
`destroyed: true` when the handler ran, so the extra call would have been a
no-op presented as a fix.

After the fix:

```
gateway.stop() took 32 ms
✔ a client abort tears down the upstream stream (349ms)
```

The same shutdown path now closes admin WebSockets with a real close frame
instead of dropping the socket: `closeAdminSockets()` in
`server/src/admin/ws.ts` keeps a set of live session closers, sends `1001`
(going away) and closes the `admin_sessions` row through the same `close()` the
normal path uses. Idle sockets are handed to `destroySoon()` so the frame is
flushed before the FIN, rather than `destroy()` cutting it. The case
`a metrics panel gets a 1001 close frame on shutdown` asserts this end to end
with a 60-line WebSocket client (`server/test/ws-client.ts`), because a client
library would have been a dependency.

## 5. Client abort is a 499, not a 500

The same case exposed a reporting bug: the log called a peer disconnect
`chat.failed` with `status 500`, `code internal_error`, `message "aborted"`.
Nothing in the gateway failed — the client left. Both inference handlers now
check `controller.signal.aborted` first and record
`chat.client_aborted` / `messages.client_aborted` at `info` with
`request_logs.status = 499`, and no error body is written to a socket that is
already gone. A real upstream failure keeps `chat.failed`.

The same 499 value is why `/admin/metrics` separates `aborted` from `errors`
(`status >= 400 AND status <> 499`): an error rate that rises when users close
tabs measures patience, not reliability. The abort test asserts this directly —
`calls 1, aborted 1, errors 0`.

## 6. Defects the suite caught before release

| Defect | Fix |
| --- | --- |
| `kind=openai` catalogue omitted `completion` | driver declares `completion` plus `caps`; `server/src/providers/openai.ts` |
| `CP_*_TIMEOUT_MS=400` silently became 300 s | invalid or < 1000 now fails boot; `server/src/config.ts` |
| SIGTERM hung on idle keep-alive sockets | `closeIdleConnections()` + force-close (§4) |
| client abort left a silent pooled socket | busy/open socket tracking (§4) |

## 7. What this gate does not prove

- Answer quality of any engine. Ollama and llama.cpp evidence lives in
  [`STEPS.md`](STEPS.md) and [`LLAMACPP-LIVE.md`](LLAMACPP-LIVE.md).
- TLS termination — not implemented.
- The 30-minute soak (RSS slope, p95 latency, chunk gaps) from S7. A 10-minute
  run is recorded in [`LIVE-CHECK.md`](LIVE-CHECK.md): 1113 streams, 0 failed,
  p95 1196 ms, max chunk gap 152 ms, slope −0.25 MB/min. Thirty minutes is still
  `NOT_TESTED`; the script supports it with `--soak-minutes=30`.

## 8. Live smoke after the change (Ollama 0.35.1)

Fixture tests prove the gateway's own logic; this pass proves it still talks to a
real engine. Command line (throwaway DB, port 8799):

```bash
cd server
GATEWAY_PORT=8799 GATEWAY_DB=/tmp/opencode/live-smoke.db \
GATEWAY_LOG=/tmp/opencode/live-smoke.jsonl GATEWAY_ADMIN_AUTH=1 \
GATEWAY_ADMIN_TOKEN=smoke CP_OLLAMA_KIND=ollama \
CP_OLLAMA_BASE_URL=http://127.0.0.1:11434 CP_OLLAMA_CAPS=tools \
node src/index.ts
```

| Probe | Output |
| --- | --- |
| `GET /health` | `{"status":"ok",...,"providers":1,"models":2}` |
| non-stream chat, `Say OK` | `HTTP/1.1 200`, `x-policy: applied;tokens=162`, `x-context-limit: 32768`, `content:"OK"` |
| stream, `curl --max-time 1` | curl exit 28 after 1772 bytes; log `chat.client_aborted`, `durationMs:1009`, `chunks:8` |
| `/admin/metrics?window_ms=600000` | `calls:2, errors:0, aborted:1` |
| `kill -TERM <pid>` | process exit after **54 ms**; log `gateway.shutdown` then `gateway.closed` |

Two things this pass checks specifically: the 499 path against a real engine
(Ollama does not care that the client left; the gateway must), and that shutdown
logs are written before exit rather than truncated by `process.exit`.
