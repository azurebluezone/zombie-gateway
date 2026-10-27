# Build steps

Order is fixed by dependency, not by enthusiasm. A step is done only when its
acceptance command prints the expected value; otherwise it is `NOT_TESTED`.

Legend: `[x]` verified on this machine · `[~]` partial · `[ ]` not started.

---

## S1 — Provider storage: DB is truth, env is a seed

**Goal:** three provider classes (ollama, llama.cpp, custom OpenAI-compatible) can
coexist, and several custom providers can share one environment without schema
churn.

**Design**
- Connection fields stay columns; everything else in `providers.config_json`.
- `api_key_env` stores a variable name; the secret never reaches SQLite.
- `enabled` belongs to the admin surface and survives restarts.
- Model identity is `(provider_id, model_id)`; two providers may expose the same
  upstream model without collision.

**Acceptance**
```bash
curl -s localhost:8787/admin/providers            # both rows, source env|admin
curl -s localhost:8787/v1/models                  # 2 providers => 4 ids
sqlite3 server/data/gateway.db "select id,enabled,config_json from providers"
```

**State:** `[x]` — measured 4 model ids from 2 providers; disabled flag survived a
restart (`docs/ADMIN-API.md`, `server/src/core/registry.ts`).

**Open:** llama.cpp binary is not installed on this machine, so the llama.cpp row
is exercised only by unit-level validation, not by a live probe → `UNVERIFIED`.

---

## S2 — Transport: name the byte path honestly

**Goal:** stop treating "transport" as a shopping list of protocols and start
treating it as *which kernel primitive carries the bytes*.

**Primitives**
| Mechanism | Movement | Copies | Our use |
| --- | --- | --- | --- |
| mmap of GGUF | page-cache view | 0 | engine-internal; we cannot subscribe to it |
| UDS | kernel socket buffer | 1 | request/response, no TCP stack |
| TCP loopback | socket buffer + loopback | 1 + stack | default for port-based engines |
| TLS | encrypted payload | + encrypt/decrypt, 1-RTT handshake | terminated in front, not per adapter |

**Why "UDS is faster" is the wrong sentence:** measured connect cost is 0.05 ms
(UDS) vs 0.12 ms (TCP), while inference on the same machine took 639–6762 ms. The
transport is ~0.01% of the wall clock. What it actually changes is the attack
surface (filesystem permissions vs a listening port) and the operational shape
(no port to expose). Details and sources: `docs/TRANSPORTS.md`.

**Acceptance**
```bash
# UDS end-to-end: bridge listens on /tmp/x.sock, provider transport=uds
curl -s --unix-socket /tmp/x.sock http://localhost/v1/models
```
**State:** `[~]` — UDS code path exists (`server/src/transport/request.ts`), tested
against a socket bridge process; no llama-server binary, so the engine-native UDS
path is `UNVERIFIED`. TLS termination is `[ ]` (belongs in front of the gateway).

---

## S3 — Admin API: one JSON control plane

**Goal:** manage providers, models, residency and metrics from a terminal, and let
a remote panel do the same without shipping this repo's code.

**Design**
- `GET /admin/routes` and `GET /admin/providers/schema` are the contract. A UI is a
  consumer of those two documents, never a fork of them.
- No HTML, no socket.io, no server-rendered form.
- `GATEWAY_ADMIN_AUTH` is a boolean switch: `0` → open admin (any origin if CORS
  allows), `1` → token required on HTTP and on the WS handshake.
- Realtime metrics: one hand-rolled RFC 6455 socket on the **same port**
  (`/admin/metrics/ws`); a handshake writes an `admin_sessions` row, the first
  frame is a full snapshot.

**Acceptance**
```bash
curl -s localhost:8787/admin/routes | jq '.data | length'          # 20
curl -s -X POST localhost:8787/admin/providers -d '{...}'          # 201
curl -s -X POST localhost:8787/admin/providers/ollama-v1/sync      # ok:true
curl -s localhost:8787/admin/metrics?window_ms=3600000 | jq .totals
node /tmp/ws-probe.mjs ws://127.0.0.1:8787/admin/metrics/ws        # metrics,pong,...
curl -s localhost:8787/admin/sessions | jq '.count'                # >= 1
```
**State:** `[x]` — 20 routes, token 401/200 matrix, `AUTH=1` without token refuses
to boot (exit 1), `AUTH=0` ignores a configured token, origin list gives 403/101,
validation 400/409, disable → `/v1/models` shrinks, purge → rows gone, metrics
aggregated per provider/model. WS: `101` with a correct `sec-websocket-accept`,
`401` without a token, frames `["metrics","pong","interval","metrics"]`, session
row closed with the negotiated `interval_ms=700` / `window_ms=600000`, three
`101`-then-destroy probes left zero open rows, plain GET → `426`.
See `docs/ADMIN-API.md`.

---

## S4 — Integration: one gateway, many clients

**Goal:** a client only needs a base URL, whether it speaks the OpenAI or the
Anthropic dialect.

**Status:** 5 of 6 done and live-verified against Ollama 0.35.1
(`qwen2.5:1.5b`) and llama.cpp 0.7.0 (`Qwen3-4B-Instruct Q4_K_M`). Client
recipes are still missing, so the step is not closed.

**Tasks**
1. `POST /v1/messages` (stateless) + `/v1/messages/count_tokens`. `[x]`
   - Measured event order: `message_start` → `content_block_start` →
     `content_block_delta` ×5 → `content_block_stop` → `message_delta` →
     `message_stop`.
   - Tool call: `content_block_start` (`tool_use`) → one `input_json_delta`
     with the full arguments → `content_block_stop`, `stop_reason: tool_use`.
   - `tool_result` replay: assistant `tool_use` + user `tool_result` produced
     "The current temperature in Dhaka is 31C and it is sunny!" — the mapping
     to `role:"tool"` is exercised, not assumed.
   - `count_tokens` answers `{"input_tokens":7,"estimated":true,...}` with
     `x-token-estimate: 1`.
2. `/v1/embeddings` passthrough. `[x]`
   - Capability gate: 400 before the wire when the catalogue lacks `embeddings`.
   - Passthrough: with `CP_*_CAPS=embeddings`, Ollama's real
     `501 "This server does not support embeddings. Start it with
     --embeddings"` reaches the caller unchanged, `x-sanitize` intact.
3. Context-window ledger (prompt + tools + images + reserve vs catalogue
   limit). `[x]` — measured in [`CONTEXT.md`](CONTEXT.md).
4. Prompt sanitizer (invisible carriers, tag-block payloads, key collisions).
   `[x]` — 24/24 unit cases, live headers in [`SANITIZE.md`](SANITIZE.md).
5. Behaviour layer (one short policy, injected once, never persisted). `[x]`
   — 13/13 unit cases; measured delta 166 tokens per call in
   [`POLICY.md`](POLICY.md).
6. Client recipes (OpenCode, KiloCode, Cline, LM Studio, plain curl). `[ ]`

**Acceptance:** each recipe file contains a command whose output is pasted next
to it, plus the exit code.

**Not proven here:** embeddings success path (no embedding model installed).
llama.cpp is now proven over **both** HTTP and UDS — the commands and outputs are
in [`LLAMACPP-LIVE.md`](LLAMACPP-LIVE.md) and summarised in the table below.

---

## S5 — Tool calling: probe, then execute

**Goal:** a model that cannot emit native `tool_calls` still drives real tools.

**Design (decided: Option B)**
1. First tool-bearing request for a model triggers **one** lazy probe; the learned
   dialect + score are persisted in `dialects(provider_id, model_id, kind,
   grammar_json, loo_score, updated_at)`.
2. Invalidation key: `model.upstream_version` + `dialect.updated_at`.
3. Request-time order: native `tool_calls` → marker block → learned dialect.
4. Two consecutive refusals inject a duty reminder, then the loop fails honestly.
5. Executor: workspace realpath + allow-list; every call appended to a JSONL log.

**Evidence the design is not invented:** `docs/research/modellab-2026-10-19/`
(`HANDOVER.md:75-78` — learned dialects 21/21 vs single grammar 9/21; native 5/5,
4/5, 0/5 across three real models).

**Acceptance**
```bash
npx tsx src/tools/probe.ts --dialect ollama/qwen2.5:1.5b   # writes one row
curl -s localhost:8787/v1/chat/completions -d '{...tools...}' | jq '.choices[0].finish_reason'
# expect "tool_calls" for both a native model and a marker-only model
```
**State:** `[ ]` — schema, probe and loop are not implemented yet. This is the next
code step, not a documentation step.

---

## S6 — Residency and queue: what "loaded in RAM" really means

**Goal:** make the only invariant (weights resident) observable and controllable.

**Done:** `POST /admin/models/load|unload` for `kind=ollama`; `/admin/runtime`
reports `expires_at` per loaded model.
**Next:** queue depth per provider (`OLLAMA_MAX_LOADED_MODELS`, `-np` for
llama.cpp) and a 429 when the queue is saturated instead of an unbounded wait.

---

## S7 — Release gate

Measured 2026-10-27; commands and outputs in
[`RELEASE-CHECK.md`](RELEASE-CHECK.md).

| Gate | State |
| --- | --- |
| `tsc --noEmit` exit 0 | `[x]` |
| Unit + integration suite (`npm test`) | `[x]` 53/53 |
| Real-engine smoke script (`tools/live-check.ts`) | `[x]` 11/11 probes, Ollama 0.35.1 (`LIVE-CHECK.md`) |
| Every `/admin` route exercised by one scripted pass | `[x]` manual, not automated (`docs/ADMIN-API.md`) |
| Failure injection: dead provider, upstream 500, socket timeout, client abort, 413 | `[x]` `npm test` |
| Prompt shutdown with an idle keep-alive socket | `[x]` < 1.5 s asserted; measured 333 ms |
| Soak: RSS slope, p95 latency, chunk gaps | `[~]` 10 min measured — 1113 streams, 0 failed, p95 1196 ms, max gap 152 ms, slope −0.25 MB/min (`LIVE-CHECK.md`); the 30-minute gate is not run |
| No `NOT_TESTED` item inside a user-facing claim | `[x]` every status row carries a label |

---

## What this machine can and cannot prove today

| Item | Label |
| --- | --- |
| Provider registry, JSON config, admin CRUD | `LIVE_PROBE_PASSED` |
| Custom provider through Ollama `/v1` (chat + tool call) | `LIVE_PROBE_PASSED` |
| Disable/purge/persistence across restart | `LIVE_PROBE_PASSED` |
| Metrics from `request_logs` | `LIVE_PROBE_PASSED` |
| `/v1/messages` non-stream, stream, tool_use, tool_result replay | `LIVE_PROBE_PASSED` |
| `/v1/embeddings` capability gate + upstream error passthrough | `LIVE_PROBE_PASSED` |
| Embeddings success (vector returned) | `UNVERIFIED` — no embedding model installed |
| Context ledger: enforce on/off, reserve floor, overflow headers | `LIVE_PROBE_PASSED` |
| Sanitizer: 24 unit cases + live prompt/response headers | `LIVE_PROBE_PASSED` |
| Behaviour layer: 13 unit cases, applied/present/off, no persisted copy | `LIVE_PROBE_PASSED` |
| Integration suite: 15 cases against a fixture upstream (500, timeout, dead provider, abort, interrupted stream, 413, shutdown, admin) | `END_TO_END_TESTED` |
| Upstream dying mid-stream → `provider_stream_error`, no `[DONE]`; client abort → log `*.client_aborted`, status 499 | `END_TO_END_TESTED` |
| llama.cpp 0.7.0 over HTTP (`Qwen3-4B Q4_K_M`, native `tool_calls`) | `LIVE_PROBE_PASSED` |
| llama.cpp 0.7.0 over **UDS** (`--host /tmp/.../llama.sock`) | `LIVE_PROBE_PASSED` |
| llama.cpp binary build from a mounted drive (`LD_LIBRARY_PATH` needed) | `LIVE_PROBE_PASSED` |
| TLS termination | `NOT_TESTED` |
| Dialects table, lazy probe, tool loop | `NOT_TESTED` — not written |
