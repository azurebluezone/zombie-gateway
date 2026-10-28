# Compatible Providers

A zero-dependency OpenAI-compatible gateway in front of local and cloud inference
engines. One base URL for Ollama, llama.cpp and any OpenAI-shaped `/v1` endpoint;
OpenAI and Anthropic request shapes in, one normalised response shape out, with a
SQLite catalogue, a JSON admin surface and a live metrics socket.

Repository: `zombie-gateway` · Package: `compatible-providers-gateway@0.1.0`
Runtime dependencies: **none** (Node builtins only).

---

## 1. What this is

| It is | It is not |
| --- | --- |
| A single OpenAI-compatible surface over several engines | A model server — it never loads weights itself |
| A catalogue: providers and models live in SQLite, the environment only seeds them | A config file reader that loses admin changes on restart |
| An integration layer that also speaks Anthropic `/v1/messages` | A second inference stack — the bytes go through one transport |
| A measurement layer: context estimates, token usage, latency and drift are reported | A tokenizer — every count is labelled an estimate |
| An observability surface: JSONL logs, request rows, WebSocket metrics | An auth provider or rate limiter (see §10) |

The design rule behind most of the code: **a number the caller cannot see is a
number the caller cannot argue with.** Every estimate, removal, refusal and
injection is published in a response header or a log field.

## 2. Status

Verified on 2026-10-26 on this machine (Ubuntu, Node 24.19.0, 4 cores) against
Ollama 0.35.1 and llama.cpp 0.7.0. Claims are labelled; an unlabelled claim is a
bug in this document.

| Capability | Evidence |
| --- | --- |
| Boot, `/health`, `/v1/models` | live |
| Ollama non-stream, stream, native tool call | live |
| llama.cpp over HTTP, `Qwen3-4B-Instruct Q4_K_M`, native `tool_calls` | live |
| llama.cpp over **Unix socket** (`--host .../llama.sock`) | live |
| Anthropic `/v1/messages`: stream, `tool_use`, `tool_result` replay | live |
| Context ledger: overflow 400, enforce-off header, reserve floor | live |
| Sanitizer: 24 unit cases + live prompt/response headers | live |
| Behaviour layer: 13 unit cases, 166-token measured delta | live |
| Admin API (20 routes), auth switch, CORS | live |
| Metrics WebSocket: 401 / 101 / frames / orphan cleanup | live |
| Failure injection: 500, timeout, dead provider, client abort, 413, prompt shutdown | `npm test` |
| Real-engine smoke script: boot, chat, stream, tool call, abort, admin, shutdown | live 11/11, [`docs/LIVE-CHECK.md`](docs/LIVE-CHECK.md) |
| Embeddings **success** (vector returned) | `UNVERIFIED` — no embedding model installed |
| Upstream HTTPS: handshake, catalogue probe, self-signed refused | `npm test` (TLS fixture) |
| TLS termination at the gateway | not implemented (see §10) |
| Automatic tool-call loop (model → tool → model) | not implemented yet |

**Live on 2026-10-28** (`/health` + `/v1/models` probe on this machine): gateway
up, 2 providers / 2 models registered — `llamacpp/llama-3.2-1b-abliterated`
(tools, 4096 ctx) and one Ollama model; `llama-server` running (pid-verified).
Source published to [`github.com/azurebluezone/zombie-gateway`](https://github.com/azurebluezone/zombie-gateway).

Full step-by-step record: [`docs/STEPS.md`](docs/STEPS.md). The llama.cpp run,
including the exact build, commands and outputs, is in
[`docs/LLAMACPP-LIVE.md`](docs/LLAMACPP-LIVE.md).

## 3. Requirements

- Node **>= 22.13** (`node:sqlite` without a flag; `--env-file-if-exists` needs
  22.9+). Tested on **24.19.0**.
- An engine to talk to: Ollama, `llama-server`, or any OpenAI-compatible API.
- No package installation is required to **run** it. `npm install` only pulls
  `typescript` and `@types/node` for type checking and for `npm run build`.

## 4. Quick start

```bash
git clone git@github.com:azurebluezone/zombie-gateway.git
cd zombie-gateway/server
npm start
```

That is the whole first run. There is no `npm install`, no `cp .env.example .env`
and no `mkdir`: `npm start` runs `scripts/setup.mjs` first, which creates `.env`
once, prepares `data/`, and prints the URL it is about to use. The server creates
its SQLite database and log on boot. Full detail, including Windows:
[`docs/INSTALL.md`](docs/INSTALL.md).

```bash
curl -s http://127.0.0.1:5252/health
curl -s http://127.0.0.1:5252/v1/models
curl -s http://127.0.0.1:5252/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"ollama/qwen2.5:1.5b","messages":[{"role":"user","content":"Say ready."}],"max_tokens":16}'
```

The port is **environment-only**: there is no compiled-in default. `5252` is
what `.env.example` ships, so `GATEWAY_PORT=5253 npm start` moves both the TCP
listener and the URLs in the log without editing code. At least one listener must
be configured — `GATEWAY_PORT` (TCP) and/or `GATEWAY_SOCKET` (Unix socket, or a
named pipe on Windows).

Models are addressed as `<provider>/<model>`. The provider prefix is the
normalised `CP_<ID>_*` group; the model part is the engine's own id.

### Optional: build to `dist/`

Running the `.ts` files directly is supported and is what `npm start` does. If a
deployment wants a plain-JS tree with no TypeScript extension in sight:

```bash
cd server
npm install --no-audit --no-fund   # once, for the compiler only
npm run build                      # clean dist/ and emit (tsc -p tsconfig.build.json)
npm run start:dist                 # node --env-file-if-exists=.env dist/index.js
```

`dist/` mirrors `src/`, so `identity.json` and `policy.md` are still found one
level up — the built tree needs no copied assets. `npm run build --keep` emits
over an existing `dist/`.

## 5. Providers

Grammar: `CP_<ID>_<FIELD>`, where `FIELD` is one of
`BASE_URL | KIND | TRANSPORT | SOCKET | API_KEY | MODELS | CAPS | TIMEOUT_MS | HEADERS`.
`<ID>` is normalised to lowercase-with-dashes and becomes the public provider id.
`TIMEOUT_MS` must be an integer ≥ 1000; an invalid value stops boot instead of
silently falling back to five minutes.

```bash
# Ollama (native /api + OpenAI /v1 on the same port)
CP_OLLAMA_KIND=ollama
CP_OLLAMA_BASE_URL=http://127.0.0.1:11434
CP_OLLAMA_CAPS=tools,embeddings

# llama.cpp over TCP (server/scripts/llama-model.sh start)
CP_LLAMACPP_KIND=llamacpp
CP_LLAMACPP_BASE_URL=http://127.0.0.1:8080
CP_LLAMACPP_CAPS=tools

# llama.cpp over a Unix socket (no TCP handshake, socket-file permissions)
CP_LLAMA_UDS_KIND=llamacpp
CP_LLAMA_UDS_BASE_URL=http://localhost
CP_LLAMA_UDS_TRANSPORT=uds
CP_LLAMA_UDS_SOCKET=/run/llama/llama.sock

# Any cloud endpoint that speaks OpenAI chat completions
CP_OPENROUTER_KIND=openai
CP_OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
CP_OPENROUTER_API_KEY=sk-...        # read at boot, never written to SQLite
CP_OPENROUTER_CAPS=tools
CP_OPENROUTER_MODELS=anthropic/claude-sonnet-4,openai/gpt-4.1
```

Rules that the code enforces:

- A provider exists only when `BASE_URL` is set: `CP_X_KIND=ollama` alone is
  ignored, because there is nothing to connect to. `CP_X_MODELS` **adds** ids the
  engine does not list; it never hides listed ids.

- `kind=openai` requires `BASE_URL` to include the version segment (`…/v1`), so
  driver paths (`/models`, `/chat/completions`) never produce `/v1/v1/…`.
- Only the **name** of the key environment variable is persisted (`api_key_ref`);
  the secret itself stays in the process.
- The environment is a **seed floor**: it inserts rows and syncs connection
  fields, but it never overrides an admin `enabled=false`.
- Capabilities are declared, never guessed. An undeclared capability is refused
  with `400` before any bytes reach the network.

Transports supported for inference: `http`, `https` (certificate verification
always on), `uds`. `ws`, `grpc` and shared memory are not inference transports;
the reasoning and the evidence are in [`docs/TRANSPORTS.md`](docs/TRANSPORTS.md).

`server/.env.example` keeps its extra provider groups **commented**: a fresh
clone seeds only Ollama, so `/v1/providers` never shows placeholders that were
never reachable. Uncomment a group to add a provider.

If you run a **modular** llama.cpp build (a `libllama-server-impl.so` next to the
binary), start it with `LD_LIBRARY_PATH=<build>/bin`; that build does not set an
rpath. A system package install does not need this.

### Local llama.cpp model

`server/scripts/llama-model.sh` is the single launcher for the local GGUF. It
starts `llama-server` with `--load-mode mmap` (weights stay a memory-mapped file,
not a heap copy), waits for `/health`, and writes every line the engine prints to
`server/logs/llama-server.jsonl`.

```bash
server/scripts/llama-model.sh start      # or: systemctl --user start llama-model
server/scripts/llama-model.sh status     # pid, n_ctx, rss, mmap yes/no
server/scripts/llama-model.sh stop
server/scripts/llama-model.sh logs 40
```

The same script backs `llama-model.service` (systemd --user, `Type=oneshot`,
`RemainAfterExit=yes`), and `zombie-gateway.service` orders itself after it.
`server/scripts/transport-check.mjs` then proves HTTP, SSE and UDS against the
documented OpenAI and Anthropic shapes and correlates each response with
`logs/access.jsonl`; it exits non-zero on the first broken shape.

### MCP server

`server/scripts/gateway-mcp.mjs` is a dependency-free stdio MCP server. It
exposes the same observability the dashboard uses: `gateway_health`,
`gateway_models`, `gateway_runtime`, `gateway_model_stats`, `gateway_logs`,
`gateway_requests` and one `gateway_chat`. Point any MCP client at it; there is
no port to open and no separate process to supervise.

```jsonc
{
  "mcp": {
    "servers": {
      "zombie": {
        "type": "local",
        "command": ["node", "/path/to/server/scripts/gateway-mcp.mjs"],
        "environment": { "GATEWAY_BASE_URL": "http://127.0.0.1:5252" }
      }
    }
  }
}
```

Setup, tool list, smoke test and limits: [`docs/MCP.md`](docs/MCP.md).

## 6. HTTP surface

Same routes on both listeners (TCP via `GATEWAY_PORT`, Unix socket or named pipe
via `GATEWAY_SOCKET`). Client recipes for curl, Node and Python — including the
Unix-socket variants — are in [`docs/CLIENTS.md`](docs/CLIENTS.md).

### Inference (no admin token)

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | Liveness, provider and model counts. |
| `GET` | `/v1/models` | Catalogue, ids qualified as `<provider>/<model>`. |
| `POST` | `/v1/chat/completions` (alias `/chat/completions`) | OpenAI chat; stateful session. |
| `POST` | `/v1/messages` (alias `/messages`) | Anthropic Messages; **stateless** by design. |
| `POST` | `/v1/messages/count_tokens` | Estimate only: `estimated: true` plus a note. |
| `POST` | `/v1/embeddings` (alias `/embeddings`) | Vector passthrough, capability-gated. |

Sessions: send `x-session-id` (or `x-client-id`) to make a conversation
addressable. `messages: []` replays the stored history for that session. The
Anthropic route stores only an attribution row, never the transcript — a
`tool_result` cannot be reconstructed from text without corrupting replay.

Response headers on every inference route:

| Header | Meaning |
| --- | --- |
| `x-request-id` | Gateway request id, also the log correlation key. |
| `x-context-limit`, `x-context-limit-source` | Catalogue window, or `unknown`. |
| `x-context-prompt-estimate` | Estimated prompt tokens. |
| `x-context-tools-estimate`, `x-context-image-estimate` | Tool schemas; images × 1024. |
| `x-context-reserve` | `max(client max_tokens, policy reserve)`. |
| `x-context-overflow-by` | Present when the request cannot fit. |
| `x-context-actual`, `x-context-estimate-ratio` | Engine-reported prompt tokens (non-stream). |
| `x-context-estimate-drift` | `1` when the estimate is off by >60% on a long prompt. |
| `x-sanitize`, `x-sanitize-output` | Carrier counts for prompt and non-stream output. |
| `x-policy` | `applied;tokens=162`, `present`, `off` or `disabled`. |

### Failure semantics

| Symptom | Reply |
| --- | --- |
| Upstream answered ≥ 400 | that status, the upstream message, a mapped `code` |
| Connect refused / DNS failure | 502 `provider_unreachable` |
| Socket idle past `TIMEOUT_MS` | 504 `provider_timeout` |
| Upstream body stopped early | 502 `provider_stream_error`; mid-stream the same envelope arrives as one final `data:` frame, and no `[DONE]` follows |
| Client left mid-stream | no error body; log `chat.client_aborted` / `messages.client_aborted` and `request_logs.status = 499`, counted as `aborted` in metrics, never as an error |

### Admin (same port, JSON + one HTML page)

The dashboard is `GET /admin/ui` (also `/dashboard`; `/` redirects there). It is
a static file, `server/public/admin.html`, that calls the admin API from the
browser on the same origin — no CORS, no token in a query string, no sample
data. Everything it shows comes from `/admin/system`, `/admin/providers`,
`/admin/models`, `/admin/runtime`, `/admin/requests`, `/admin/sessions`,
`/admin/metrics`, `/admin/model-stats` and `/admin/logs`, plus the
`/admin/metrics/ws` socket (20 s client ping, 25 s server ping, reconnect
backoff capped at 15 s).

The Runtime page answers "which model answered, how many requests, how slow":
one row per model with calls, errors, average and max latency, tokens in/out and
the last request time. The Logs page tails any of the four files below in place.

Every request, success or failure, appends one line to `server/logs/access.jsonl`
(`GATEWAY_ACCESS_LOG`, rotated at 8 MiB). Lifecycle events stay in
`server/logs/gateway.jsonl`, so request noise never buries them. The local
llama.cpp engine adds `server/logs/llama-server.jsonl` (engine output) and
`server/logs/llama-model.log` (supervisor). `/admin/system` reports the absolute
directory under `logs`.

### Admin auth and routes

`GATEWAY_ADMIN_AUTH` is the single switch:

- `0` — open; a configured token is ignored.
- `1` — token required on every `/admin` route and on the WebSocket handshake;
  boot fails if `GATEWAY_ADMIN_TOKEN` is empty.
- unset — enforcement only when a token is configured.

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5252/admin/ui   # dashboard
curl -s http://127.0.0.1:5252/admin/routes                 # self-description
curl -s http://127.0.0.1:5252/admin/system                 # identity, policy, counts
curl -s http://127.0.0.1:5252/admin/providers/schema       # field spec + examples
curl -s -X POST http://127.0.0.1:5252/admin/sync           # discover every provider
curl -s -X POST http://127.0.0.1:5252/admin/models/load \
  -H 'content-type: application/json' -d '{"model":"ollama/qwen2.5:1.5b"}'  # any id from /v1/models
```

Token via `Authorization: Bearer …`, `x-admin-token: …`, or `?token=` on the
WebSocket only. Full route table and field spec: [`docs/ADMIN-API.md`](docs/ADMIN-API.md).

### Metrics

`GET /admin/metrics/ws` (also `/admin/ws`) upgrades to WebSocket, hand-rolled
RFC 6455 on the same port. Frames carry request counters, latency percentiles
and per-provider state derived from `request_logs`. Origin checking uses the same
`GATEWAY_ADMIN_ORIGINS` list as CORS.

## 7. Prompt hygiene

An invisible-carrier sanitizer with three modes: `strip` (default), `report`,
`off`. It removes zero-width space, bidi overrides (Trojan Source), the Unicode
tag block, BOM, soft hyphen and control bytes — while keeping a single ZWJ/ZWNJ
between letters of a joining script (Bengali, Arabic/Persian, other Indic, Khmer,
Mongolian, Hangul) or between emoji, because those are orthography, not carriers.

Removal is never silent: counts are returned in `x-sanitize` / `x-sanitize-output`,
a non-clean prompt writes a `sanitize.prompt` log line, and a JSON key collision
keeps both keys and flags it. Streaming output is **scanned but not rewritten** —
a carrier can straddle two chunks. Details: [`docs/SANITIZE.md`](docs/SANITIZE.md).

## 8. Context ledger

```
total = prompt_estimate + message_overhead + tools_estimate
      + image_estimate + reserve
```

The limit is `models.context_length`, filled from the engine's own report. An
unknown limit is reported as `unknown` and **never** enforced or invented.
Overflow is a `400 context_length_exceeded` that prints every component; with
`GATEWAY_CONTEXT_ENFORCE=0` the request runs and the header says by how much it
overflows. Drift is judged only when the engine reports real usage and the
prompt is longer than 512 tokens. Details: [`docs/CONTEXT.md`](docs/CONTEXT.md).

## 9. Behaviour layer

`server/policy.md` is a seven-rule text (647 chars, ~162 estimated tokens),
injected once per request into the outgoing copy only.

- **Once.** A marker line is the dedupe key; if the client or a plugin already
  carries it, nothing is added (`x-policy: present`).
- **Never persisted.** The session store keeps the client transcript, so replay
  cannot multiply the text.
- **Visible.** `x-policy` names the state and the token cost.
- **Optional.** `GATEWAY_POLICY=off`, or per call `x-policy: off`.

Details and measurements: [`docs/POLICY.md`](docs/POLICY.md).

## 10. Security model

- Bind to loopback unless you put a reverse proxy in front. **Inference routes
  are not authenticated**; the admin token protects `/admin` and the metrics
  socket only.
- TLS is terminated by a proxy, not by this process. Upstream HTTPS always
  verifies certificates; `rejectUnauthorized` is never disabled in the codebase.
- CORS is wildcard by default (safe here: bearer tokens, no cookies). Pin it with
  `GATEWAY_ADMIN_ORIGINS`.
- Secrets are read from the environment and never written to SQLite or logs.
- Request bodies are capped (`GATEWAY_BODY_LIMIT_BYTES`) and JSON nesting deeper
  than 64 levels is rejected instead of walked.
- Untrusted text — prompts, tool output, logs, web pages — is treated as data.
  The sanitizer removes carriers; it never interprets content.

## 11. Project layout

```
server/
  src/
    index.ts            boot: config, DB, registry, identity, policy, listen
                        (TCP and/or Unix socket, shared shutdown path)
    server.ts           routing, CORS, identity headers, body limit
    config.ts           GATEWAY_* and CP_* grammar; env-only port, path root
    identity.ts         read-only identity.json + sha256
    core/               chat, messages, context, sanitize, policy, session,
                        catalog, registry, metrics, tokens, db, errors, logger
    adapters/           openai-chat, anthropic, anthropic-stream, sse
    providers/          ollama, llamacpp, openai, opencode drivers
    transport/          http/https/uds request path
    admin/              JSON API, schema, WebSocket
    tools/probe.ts      manual catalogue probe
  scripts/
    setup.mjs           first run: .env, data dirs, engine probe (prestart)
    build.mjs           emit runtime to dist/ (tsc -p tsconfig.build.json)
    llama-model.sh      start/stop/restart/status for the local GGUF (mmap)
    transport-check.mjs HTTP + SSE + UDS conformance run against a live gateway
    gateway-mcp.mjs     MCP stdio server: gateway health, models, stats, logs
  logs/                 llama-server.jsonl, llama-model.log, gateway.jsonl,
                        access.jsonl (all append-only, request ids correlate)
  tsconfig.build.json   emit config; tsconfig.json stays noEmit
  dist/                 build output (gitignored), mirrors src/
  tools/live-check.ts   real-engine check: boot, chat, stream, tool call,
                        abort, admin auth, soak, shutdown
  policy.md             behaviour layer text
  identity.json         system identity (read-only at runtime)
  .env.example          every supported variable
  test/                 node:test suites (sanitize, policy, integration)
  test/fixtures/        self-signed localhost cert for the HTTPS test only
docs/                   install, clients/transport, admin, context, sanitize,
                        MCP, policy, steps, release check, live check
```

## 12. Tests

```bash
cd server
npm run typecheck                    # tsc --noEmit
npm test                             # 55 cases: sanitizer 24, policy 13,
                                     # integration 18
```

Measured on 2026-10-27: `tsc --noEmit` exit 0; 55/55 tests pass.

Live engines are checked by `server/tools/live-check.ts`, which spawns the real
gateway against Ollama and prints one PASS/FAIL/SKIP line per probe — boot,
catalogue, non-stream chat, streaming, `count_tokens`, tool call, client abort,
admin auth, the embeddings gate, an optional soak and shutdown:

```bash
cd server
node tools/live-check.ts --soak=3          # three timed requests
node tools/live-check.ts --soak-minutes=10 # RSS slope, p95 latency, chunk gaps
```

It exits 1 when any probe fails, and a SKIP always carries its reason. The last
recorded run is in [`docs/LIVE-CHECK.md`](docs/LIVE-CHECK.md).

The integration suite spawns the real entry point against a fixture upstream and
injects what a real engine will not produce on demand: upstream 500, socket
timeout, dead provider, client abort mid-stream, oversized body, SIGTERM with an
open socket, admin auth and one create/disable/purge cycle. Results, including
the shutdown defect it found, are in
[`docs/RELEASE-CHECK.md`](docs/RELEASE-CHECK.md).

The live checks quoted in the status table are documented next to their numbers
in [`docs/STEPS.md`](docs/STEPS.md), [`docs/CONTEXT.md`](docs/CONTEXT.md),
[`docs/SANITIZE.md`](docs/SANITIZE.md) and [`docs/POLICY.md`](docs/POLICY.md).

## 13. License and provenance

License: **Proprietary — Local Freedom Protocol**, as declared in
`server/identity.json`. No `LICENSE` file is included yet; add the canonical text
before publishing binaries.

The research archive under `docs/research/modellab-2026-10-19/` is third-party
material kept with its original provenance and checksums; see
`PROVENANCE.txt` inside it.
