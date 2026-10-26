# Admin API

Base URL: `http://127.0.0.1:8787` (or `GATEWAY_HOST` / `GATEWAY_PORT`).
Every route below is JSON in, JSON out. This process renders **no HTML** and ships
**no admin UI**: a terminal, a script, or a remote panel can drive the whole
system with `curl`. The only non-HTTP surface is one WebSocket on the *same port*
(`/admin/metrics/ws`) that pushes the metrics snapshot in real time.

## Authentication: one boolean switch

Two variables, one decision.

| `GATEWAY_ADMIN_AUTH` | `GATEWAY_ADMIN_TOKEN` | Behaviour |
| --- | --- | --- |
| `0` / `false` | anything | Admin HTTP **and** the metrics socket are open. A configured token is ignored. |
| `1` / `true` | set | Every `/admin` route and the WebSocket handshake require the token. Missing/wrong → `401`. |
| `1` / `true` | empty | **Boot fails** (exit 1): a switch that promises protection must not start unprotected. |
| unset | set | Token enforced (previous behaviour kept). |
| unset | empty | Open. |

```bash
export GATEWAY_ADMIN_AUTH=1
export GATEWAY_ADMIN_TOKEN=secret-token
curl -s -H 'authorization: Bearer secret-token' http://127.0.0.1:8787/admin/providers
curl -s -H 'x-admin-token: secret-token'         http://127.0.0.1:8787/admin/providers
```

A browser cannot set an `Authorization` header on a WebSocket, so the socket also
accepts `?token=<token>`. `GATEWAY_ADMIN_AUTH=0` is the intended mode for a
`file://` page or a panel on the same machine: nothing to paste, nothing to leak.

`/health` and `/v1/*` are never behind the admin switch: they are the OpenAI face.

### CORS / origin

- `GATEWAY_ADMIN_ORIGINS` empty → `access-control-allow-origin: *`. Safe because
  auth is a bearer token and no cookie is ever accepted, so a foreign page cannot
  borrow a session.
- Set a comma list to pin origins: `https://panel.example, null` (`null` is the
  origin a `file://` page sends).
- The WebSocket path enforces the same list at the handshake (`403` otherwise).
  An empty list means: accept the handshake regardless of origin.

Nothing here depends on the panel's stack: Node, Next, Python, React, or a single
`file://` HTML page all work if the origin and token match.

## Provider storage model

| Layer | What lives there |
| --- | --- |
| `providers` columns | `id`, `kind`, `base_url`, `transport`, `socket_path`, `api_key_ref`, `enabled`, `declared_caps`, probe state |
| `providers.config_json` | `headers`, `models`, `timeout_ms`, `source`, `notes`, `extra` — everything provider-specific |
| environment `CP_<ID>_*` | a **seed floor**: inserted once, kept in sync for connection fields |
| SQLite row | the runtime truth; `enabled` is owned by the admin API and survives restarts |

Consequences:

- A new custom-provider field lands in `extra`; **no migration and no new column**.
- `api_key_env` stores the *name* of an environment variable. The secret value is
  read into memory at load time and never written to SQLite.
- Deleting a provider with `?purge=1` removes the row (cascade to models); without
  it the row stays disabled, so a mistaken click is reversible.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/admin/routes` | Self-description: every operation, body and query. |
| `GET` | `/admin/system` | Identity, identity sha256, DB path, uptime, counts, auth switch, prompt-hygiene config. |
| `GET` | `/admin/providers` | All providers (disabled included). `?enabled=0` filters. |
| `GET` | `/admin/providers/schema` | Field spec + curl-ready examples. This is the form. |
| `POST` | `/admin/providers` | Create provider (DB row + live registry, no restart). |
| `GET` | `/admin/providers/:id` | One provider with probe state and model count. |
| `PATCH` | `/admin/providers/:id` | Partial update. |
| `DELETE` | `/admin/providers/:id` | Disable, or purge with `?purge=1`. |
| `POST` | `/admin/providers/:id/enable` | Re-enable. |
| `POST` | `/admin/providers/:id/disable` | Hide models without deleting rows. |
| `POST` | `/admin/providers/:id/sync` | Discover that provider now. |
| `POST` | `/admin/sync` | Discover every enabled provider. |
| `GET` | `/admin/models` | Catalogue with `provider_enabled`. `?include_disabled=1`. |
| `POST` | `/admin/models/load` | Warm a model into RAM (`kind=ollama` only). |
| `POST` | `/admin/models/unload` | Drop it from RAM (`kind=ollama` only). |
| `GET` | `/admin/runtime` | Reachability + loaded models per provider. |
| `GET` | `/admin/metrics` | Window aggregates, per provider/model/minute. |
| `GET` | `/admin/requests` | Recent request log rows. |
| `GET` | `/admin/sessions` | Admin panel sessions (one row per WS handshake). `?limit=50&open=1`. |
| `GET` | `/admin/metrics/ws` | WebSocket upgrade (also `/admin/ws`). See the protocol below. |

## Public inference routes

Not admin routes; listed here because the admin panel is expected to drive them
too. All three accept the same `<provider>/<model>` ids as `/v1/models`.

| Method | Path | Protocol |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` (alias `/chat/completions`) | OpenAI chat, stateful session |
| `POST` | `/v1/messages` (alias `/messages`) | Anthropic Messages, **stateless** |
| `POST` | `/v1/messages/count_tokens` | Estimate only, `estimated: true` |
| `POST` | `/v1/embeddings` (alias `/embeddings`) | Vector passthrough |

`/v1/messages` is stateless on purpose: Anthropic clients resend the full
transcript, and a `tool_result` cannot be rebuilt from stored text without
corrupting replay. The call is still attributed to a session row.

Response headers on every inference route:

| Header | Meaning |
| --- | --- |
| `x-context-limit` | Catalogue context length, or `unknown`. |
| `x-context-limit-source` | `catalog`, `assumed` (never set by default), `unknown`. |
| `x-context-prompt-estimate` | Estimated prompt tokens, message overhead included. |
| `x-context-tools-estimate` | Estimated cost of the tool schemas. |
| `x-context-image-estimate` | Images × 1024 (a bound, not a measurement). |
| `x-context-reserve` | Output tokens reserved: `max(client max_tokens, policy)`. |
| `x-context-overflow-by` | Present when the request cannot fit. |
| `x-context-actual` | Engine-reported prompt tokens (non-stream only). |
| `x-context-estimate-ratio` | actual ÷ estimate; only when the engine reported usage. |
| `x-context-estimate-drift` | `1` when the estimate is off by > 60% on a long prompt. |
| `x-sanitize` | Prompt hygiene counts, e.g. `zero-width:2,unicode-tag:3;hidden-payload`. |
| `x-sanitize-output` | Same, for non-stream model output. |
| `x-policy` | `applied;tokens=162`, `present`, `off` or `disabled`. See [`POLICY.md`](POLICY.md). |

Details: [`SANITIZE.md`](SANITIZE.md), [`CONTEXT.md`](CONTEXT.md).

`/admin/system` reports the live policy: `sanitize`, `context_enforce`,
`output_reserve`, `policy` (enabled, mode, file, sha256, tokens), plus
`token_estimator` saying in one line that the number is an estimate.

## Field spec (summary)

Full machine-readable version: `GET /admin/providers/schema`.

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Namespace for model ids. Derived from kind+host+port if omitted. |
| `kind` | enum | `ollama` `llamacpp` `openai` `opencode` |
| `base_url` | url | See the version-segment rule below. |
| `transport` | enum | `http` `https` `uds` (`ws` rejected with 501 for inference) |
| `socket_path` | string | Required for `uds`. Filesystem permissions become access control. |
| `api_key_env` | env name | `^[A-Z][A-Z0-9_]*$`; a secret-looking value is rejected. |
| `headers` | object | String values only; CRLF injection rejected. |
| `models` | string[] | Declared models for engines whose `/models` is empty. |
| `caps` | string[] | `completion` `tools` `thinking` `embeddings` `vision` |
| `timeout_ms` | integer | `>= 1000`, default `300000` |
| `enabled` | boolean | Default `true` |
| `notes` | string | Human note |
| `extra` | object | Arbitrary JSON, ≤ 64 KB, stored verbatim |

### The version-segment rule

Paths are concatenated onto `base_url`:

- `kind=ollama` → `base_url` is the server root, paths are `/api/tags`, `/v1/chat/completions`.
- `kind=openai` → `base_url` **includes** the version segment, paths are `/models`
  and `/chat/completions`. `http://host:11434/v1` is correct; `http://host:11434`
  would call `http://host:11434/models`.

## Quickstart

```bash
# 1. Ollama natively (full capability discovery via /api/tags)
curl -s -X POST localhost:8787/admin/providers -H 'content-type: application/json' -d '{
  "id": "ollama", "kind": "ollama", "base_url": "http://127.0.0.1:11434"
}'

# 2. The same Ollama through its OpenAI /v1 surface (the custom bucket)
curl -s -X POST localhost:8787/admin/providers -H 'content-type: application/json' -d '{
  "id": "ollama-v1", "kind": "openai", "base_url": "http://127.0.0.1:11434/v1",
  "caps": ["completion", "tools"], "extra": {"role": "test-mirror"}
}'

# 3. llama.cpp over a unix socket
curl -s -X POST localhost:8787/admin/providers -H 'content-type: application/json' -d '{
  "id": "llamacpp", "kind": "llamacpp", "base_url": "http://localhost",
  "transport": "uds", "socket_path": "/run/llama.sock", "caps": ["completion"]
}'

curl -s -X POST localhost:8787/admin/providers/ollama-v1/sync
curl -s localhost:8787/v1/models | python3 -m json.tool
curl -s 'localhost:8787/admin/metrics?window_ms=3600000' | python3 -m json.tool
curl -s localhost:8787/admin/runtime | python3 -m json.tool

# 4. Realtime: same port, same token (GATEWAY_ADMIN_AUTH=1 → ?token=...)
node --eval '
  const ws = new WebSocket("ws://127.0.0.1:8787/admin/metrics/ws?token=secret-token");
  ws.onmessage = (e) => { const m = JSON.parse(e.data); console.log(m.type, m.seq ?? ""); if (m.seq === 2) ws.close(); };
'
curl -s localhost:8787/admin/sessions | python3 -m json.tool
```

Residency:

```bash
curl -s -X POST localhost:8787/admin/models/load   -H 'content-type: application/json' \
  -d '{"model":"ollama/qwen2.5:1.5b","keep_alive":"30m"}'
curl -s -X POST localhost:8787/admin/models/unload -H 'content-type: application/json' \
  -d '{"model":"ollama/qwen2.5:1.5b"}'
```

`load`/`unload` use Ollama's native `/api/generate` `keep_alive` field. Any other
kind returns `501 unsupported`, because llama.cpp and generic `/v1` endpoints have
no standard residency control — pretending otherwise would be a lie.

## Metrics semantics

- Window: `window_ms`, clamped to 1 minute … 7 days, default 1 hour.
- `calls`, `errors` (`status >= 400`), `avg_ms`, `max_ms`, `avg_ttfb_ms`, token sums.
- `p95_ms` is computed from the last 500 rows in the window, not the whole table.
- `buckets` are per-minute rows of the window, newest first, capped at 60.
- Everything comes from `request_logs`; there is no second counter to drift.

## Realtime metrics over WebSocket

Path: `ws://<host>:<port>/admin/metrics/ws` (alias `/admin/ws`). Same port as HTTP,
same auth switch, same origin list. Hand-rolled RFC 6455 (no dependency): text,
ping, pong, close.

**Lifecycle**

1. Upgrade with the token if `GATEWAY_ADMIN_AUTH=1`: `?token=...`,
   `x-admin-token: ...`, or `Authorization: Bearer ...`. A rejected handshake is a
   plain HTTP `401`/`403` with a JSON body, not a silent socket close.
2. On `101 Switching Protocols` one row is inserted into `admin_sessions`
   (`id`, `kind='ws'`, `remote_addr`, `user_agent`, `interval_ms`, `opened_at`,
   `meta`), and the **first frame is a full snapshot** — no waiting for an interval.
3. The server pushes `metrics` frames every `interval_ms` (default 2000).
4. The row is closed (`closed_at`, final `frames`, negotiated `interval_ms` and
   `window_ms`) when the socket ends, including the hostile case of a client that
   destroys the TCP connection right after the `101`.

A plain `GET /admin/metrics/ws` (curl, browser address bar) answers `426 Upgrade
Required` with a JSON hint, because the route only speaks WebSocket.

Rows left open by a killed process are closed at the next boot and logged as
`admin.sessions_orphaned`, so `?open=1` never reports a zombie session.

**Client → server**

| Message | Effect |
| --- | --- |
| `{"type":"ping"}` | Replies `{"type":"pong","ts":...}`. |
| `{"type":"set_interval","interval_ms":700}` | Clamped to 500…60000; replies `{"type":"interval"}`. |
| `{"type":"set_window","window_ms":600000}` | Clamped to 1 min…7 days; pushes a snapshot immediately. |
| `{"type":"snapshot"}` | Pushes a snapshot immediately. |

**Server → client**

```json
{
  "type": "metrics",
  "session_id": "e3111a43-…",
  "seq": 1,
  "ts": "2026-10-26T21:52:43.272Z",
  "interval_ms": 2000,
  "window_ms": 3600000,
  "data": { "totals": {}, "providers": [], "models": [], "buckets": [] }
}
```

`data` is exactly `GET /admin/metrics`'s body, so a panel needs one parser for both.

**Browser client (works from `file://`)**

```js
const ws = new WebSocket(`ws://127.0.0.1:8787/admin/metrics/ws?token=${token}`);
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.type === "metrics") render(message.data);
};
// const ws = new WebSocket("ws://127.0.0.1:8787/admin/metrics/ws"); // GATEWAY_ADMIN_AUTH=0
```

**Measured on this machine** (Node 24 global `WebSocket` + a raw `net` handshake
probe, `GATEWAY_ADMIN_AUTH=1`):

```text
no token      → HTTP/1.1 401 Unauthorized   {"code":"unauthorized"}
wrong token   → HTTP/1.1 401 Unauthorized
?token=...    → HTTP/1.1 101 Switching Protocols, sec-websocket-accept matches RFC 6455
frames        → ["metrics","pong","interval","metrics"]  (first frame is a snapshot)
admin_sessions→ interval_ms=700, meta.window_ms=600000, frames=4, closed_at set
3× 101+destroy→ 3 close events, 0 rows left open
plain GET     → 426 not_implemented with a ws:// hint
```

**Why hand-rolled:** the runtime has zero dependencies, and this protocol needs
three frame types. ~380 lines (`server/src/admin/ws.ts`) against a dependency that
would take over the HTTP `upgrade` path is a trade we can defend.

## Error codes added by this surface

| HTTP | code | Meaning |
| --- | --- | --- |
| 400 | `invalid_request_error` | Field validation failed (`param` says which). |
| 401 | `unauthorized` | Admin token missing or wrong (HTTP or WS handshake). |
| 403 | `invalid_request_error` | WebSocket origin not in `GATEWAY_ADMIN_ORIGINS`. |
| 404 | `provider_not_found` | No such provider id. |
| 409 | `provider_exists` | Create collided with an existing id. |
| 409 | `sync_in_progress` | Another full sync is running. |
| 426 | `not_implemented` | The WebSocket path was requested as plain HTTP. |
| 501 | `unsupported` | Operation has no wire contract on this kind (e.g. residency on `/v1`). |

## Identity

`identity.json` is read once at boot, never written back. Its sha256 is published
by `/admin/system`. Response headers (disable with `GATEWAY_IDENTITY_HEADERS=0`):

```
x-system-identity: Compatible Providers
x-system-version: 0.1.0
x-system-owner: Sahon Srabon
x-powered-by: CompatibleProviders-by-SahonSrabon
```
