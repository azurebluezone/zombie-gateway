# MCP server

The gateway exposes one tool registry over three transports:

| Transport | Endpoint | Client shape |
| --- | --- | --- |
| stdio | `node server/scripts/gateway-mcp.mjs` | Process started by the MCP client |
| Streamable HTTP | `POST/GET/DELETE /mcp` | `Mcp-Session-Id` + `MCP-Protocol-Version` headers |
| Legacy HTTP+SSE | `GET /sse`, `POST /messages` | `endpoint` event, then JSON-RPC replies on the stream |

The tool list lives in `server/scripts/mcp-tools.mjs` and is shared by all three,
so adding a tool once makes it visible everywhere. Every tool is one HTTP call
to the gateway's public API, so there is no second source of truth and no cached
copy that can drift.

It exists because the previous configuration pointed at
`http://127.0.0.1:9999/mcp`, a port nothing listens on, so every client saw
`ECONNREFUSED`. A local process started by the client removes that failure mode:
there is no port to forget to open, and the client owns the process lifetime.
The HTTP transports cover clients that cannot start a process (browsers, remote
agents, containers).

## Tools

| Tool | Route | Answers |
| --- | --- | --- |
| `gateway_health` | `GET /health` | Is the gateway up, how many providers/models |
| `gateway_models` | `GET /v1/models` | Which public model ids exist |
| `gateway_runtime` | `GET /admin/runtime` | Which model is resident, alias, quant, ctx, slots |
| `gateway_model_stats` | `GET /admin/model-stats` | Per-model calls, errors, avg/max latency, tokens, last request |
| `gateway_logs` | `GET /admin/logs` | Tail one of the four files in `server/logs/`, with its absolute path |
| `gateway_requests` | `GET /admin/requests` | Recent request rows with status, duration, tokens |
| `gateway_chat` | `POST /v1/chat/completions` | One non-streaming answer with model, usage and latency |

Read-only except `gateway_chat`, which spends local CPU. Keep `max_tokens` small
on a 1B CPU model.

## HTTP transports

The same gateway process serves MCP on its normal HTTP port, and on the optional
TLS port when `GATEWAY_TLS_PORT` is set:

| URL | Transport | Notes |
| --- | --- | --- |
| `http://127.0.0.1:5010/mcp` | Streamable HTTP | `POST` JSON-RPC; `GET` event stream; `DELETE` ends the session |
| `http://127.0.0.1:5010/sse` | Legacy HTTP+SSE | First frame is `event: endpoint`; replies arrive as `event: message` |
| `http://127.0.0.1:5010/messages?sessionId=…` | Legacy reply channel | Named by the `endpoint` frame |
| `https://127.0.0.1:5011/mcp`, `/sse`, `/messages` | Same routes over TLS | Set `GATEWAY_TLS_PORT`, `GATEWAY_TLS_CERT`, `GATEWAY_TLS_KEY` |

Protocol revisions: the gateway implements `2025-11-25` (newest), `2025-06-18`,
`2025-03-26` and `2024-11-05`. `initialize` echoes the client's revision when it
is supported and falls back to `2025-11-25` otherwise. Later requests carry
`MCP-Protocol-Version`; a value outside that list is rejected with `400` and a
JSON-RPC error.

Session and CORS headers:

- `Mcp-Session-Id` is issued by `initialize` and required on later `/mcp` calls.
- `MCP-Protocol-Version` is returned on every MCP response.
- `access-control-allow-origin: *` plus `access-control-expose-headers:
  mcp-session-id, mcp-protocol-version` make the transport usable from a browser
  and from a non-browser client without a second configuration path.

Minimal session with curl:

```bash
curl -sS http://127.0.0.1:5010/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"curl","version":"1"}}}'
# capture the Mcp-Session-Id response header, then:
curl -sS http://127.0.0.1:5010/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'mcp-session-id: <id>' -H 'mcp-protocol-version: 2025-11-25' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
```

## Client

`server/scripts/mcp-http-client.mjs` speaks both HTTP transports and needs no
dependency beyond Node's `fetch`:

```bash
# Streamable HTTP over plain HTTP
node server/scripts/mcp-http-client.mjs \
  --url http://127.0.0.1:5010/mcp --call gateway_health

# Same over HTTPS with the local test certificate
node server/scripts/mcp-http-client.mjs \
  --url https://127.0.0.1:5011/mcp --insecure --call gateway_health

# Legacy HTTP+SSE
node server/scripts/mcp-http-client.mjs \
  --url http://127.0.0.1:5010/sse --call gateway_health

# Machine-readable summary
node server/scripts/mcp-http-client.mjs \
  --url http://127.0.0.1:5010/mcp --json
```

It runs `initialize` → `notifications/initialized` → `tools/list` → optional
`tools/call`, prints `tools=7` and `tool=<name> status=<status>`, and sends the
Streamable HTTP `DELETE` so the session does not linger.

## Configuration

OpenCode V2, global config (`~/.opencode/opencode.json` on this machine; V2 also
reads `~/.config/opencode/opencode.json`):

```jsonc
{
  "mcp": {
    "servers": {
      "zombie": {
        "type": "local",
        "command": [
          "node",
          "/home/sahon/zombie-gateway-main/server/scripts/gateway-mcp.mjs"
        ],
        "environment": {
          "GATEWAY_BASE_URL": "http://127.0.0.1:5010"
        }
      }
    }
  }
}
```

Environment read by the server:

| Variable | Default | Purpose |
| --- | --- | --- |
| `GATEWAY_BASE_URL` | `http://127.0.0.1:5010` | Gateway origin |
| `GATEWAY_ADMIN_TOKEN` | empty | Bearer token for `/admin` routes when `GATEWAY_ADMIN_AUTH=1` |
| `GATEWAY_MCP_TIMEOUT_MS` | `120000` | Per-request budget; local CPU generation is slow |

Tools are named `<server>_<tool>` (`zombie_gateway_health`). Under Code Mode they
appear as `tools.zombie.gateway_health(...)`.

## Verify

```bash
opencode mcp list          # ✓ zombie  connected
```

Protocol smoke test without a client — newline-delimited JSON-RPC on stdin:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"gateway_health","arguments":{}}}' \
  | node server/scripts/gateway-mcp.mjs
```

Expected: `initialize` echoes the protocol version and `serverInfo.name` is
`zombie-gateway`, `tools/list` returns seven names, and `gateway_health` returns
the same JSON as `curl /health`. Diagnostics go to stderr only; stdout is the
protocol stream.

For the HTTP transports, with the gateway already running:

```bash
node server/scripts/mcp-http-client.mjs \
  --url http://127.0.0.1:5010/mcp --call gateway_health
node server/scripts/mcp-http-client.mjs \
  --url https://127.0.0.1:5011/mcp --insecure --call gateway_health
node server/scripts/mcp-http-client.mjs \
  --url http://127.0.0.1:5010/sse --call gateway_health
```

Expected in each case: `transport=…`, `tools=7`,
`tool=gateway_health status=ok`, then `OK`.

## Limits

- `llama-server` runs with `--parallel 1`. One long generation blocks the next
  request, so a client can wait behind another session's turn. Raise `--parallel`
  in `scripts/llama-model.sh` (and accept the context split) if that matters more
  than per-request speed.
- The MCP server does not stream: `gateway_chat` is one non-streaming call.
- No write tools. Provider/model admin operations stay in the admin API and the
  dashboard, where the token and the audit line already exist.
