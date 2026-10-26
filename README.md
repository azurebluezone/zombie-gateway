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
| Embeddings **success** (vector returned) | `UNVERIFIED` — no embedding model installed |
| TLS termination at the gateway | not implemented (see §10) |
| Automatic tool-call loop (model → tool → model) | not implemented yet |

Full step-by-step record: [`docs/STEPS.md`](docs/STEPS.md). The llama.cpp run,
including the exact build, commands and outputs, is in
[`docs/LLAMACPP-LIVE.md`](docs/LLAMACPP-LIVE.md).

## 3. Requirements

- Node with `node:sqlite` available without a flag (tested on **24.19.0**).
- An engine to talk to: Ollama, `llama-server`, or any OpenAI-compatible API.
- No package installation is required to **run** it. `npm install` only pulls
  `typescript` and `@types/node` for type checking.

## 4. Quick start

```bash
cd server
cp .env.example .env          # edit the CP_* block for your engines
npm install --no-audit --no-fund
npm run typecheck             # tsc --noEmit, expect exit 0
npm start                     # node src/index.ts
```

```bash
curl -s http://127.0.0.1:8787/health
curl -s http://127.0.0.1:8787/v1/models
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"ollama/qwen2.5:1.5b","messages":[{"role":"user","content":"Say ready."}],"max_tokens":16}'
```

Models are addressed as `<provider>/<model>`. The provider prefix is the
normalised `CP_<ID>_*` group; the model part is the engine's own id.

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

# llama.cpp over TCP
CP_LLAMA_KIND=llamacpp
CP_LLAMA_BASE_URL=http://127.0.0.1:8080
CP_LLAMA_CAPS=tools

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

If you run a **modular** llama.cpp build (a `libllama-server-impl.so` next to the
binary), start it with `LD_LIBRARY_PATH=<build>/bin`; that build does not set an
rpath. A system package install does not need this.

## 6. HTTP surface

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

### Admin (JSON only, same port)

`GATEWAY_ADMIN_AUTH` is the single switch:

- `0` — open; a configured token is ignored.
- `1` — token required on every `/admin` route and on the WebSocket handshake;
  boot fails if `GATEWAY_ADMIN_TOKEN` is empty.
- unset — enforcement only when a token is configured.

```bash
curl -s http://127.0.0.1:8787/admin/routes                 # self-description
curl -s http://127.0.0.1:8787/admin/system                 # identity, policy, counts
curl -s http://127.0.0.1:8787/admin/providers/schema       # field spec + examples
curl -s -X POST http://127.0.0.1:8787/admin/sync           # discover every provider
curl -s -X POST http://127.0.0.1:8787/admin/models/load \
  -H 'content-type: application/json' -d '{"model":"ollama/qwen2.5:1.5b"}'
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
    server.ts           routing, CORS, identity headers, body limit
    config.ts           GATEWAY_* and CP_* grammar
    identity.ts         read-only identity.json + sha256
    core/               chat, messages, context, sanitize, policy, session,
                        catalog, registry, metrics, tokens, db, errors, logger
    adapters/           openai-chat, anthropic, anthropic-stream, sse
    providers/          ollama, llamacpp, openai, opencode drivers
    transport/          http/https/uds request path
    admin/              JSON API, schema, WebSocket
    tools/probe.ts      manual catalogue probe
  policy.md             behaviour layer text
  identity.json         system identity (read-only at runtime)
  .env.example          every supported variable
  test/                 node:test suites (sanitize, policy, integration)
docs/                   transport, admin, context, sanitize, policy, steps,
                        release check
```

## 12. Tests

```bash
cd server
npm run typecheck                    # tsc --noEmit
npm test                             # 49 cases: sanitizer 24, policy 13,
                                     # integration 12
```

Measured on 2026-10-27: `tsc --noEmit` exit 0; 49/49 tests pass.

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
