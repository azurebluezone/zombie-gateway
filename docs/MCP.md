# MCP server

`server/scripts/gateway-mcp.mjs` exposes this gateway to any MCP client over the
stdio transport. It is a thin wrapper: every tool is one HTTP call to the
gateway's public API, so there is no second source of truth and no cached copy
that can drift.

It exists because the previous configuration pointed at
`http://127.0.0.1:9999/mcp`, a port nothing listens on, so every client saw
`ECONNREFUSED`. A local process started by the client removes that failure mode:
there is no port to forget to open, and the client owns the process lifetime.

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
          "GATEWAY_BASE_URL": "http://127.0.0.1:5252"
        }
      }
    }
  }
}
```

Environment read by the server:

| Variable | Default | Purpose |
| --- | --- | --- |
| `GATEWAY_BASE_URL` | `http://127.0.0.1:5252` | Gateway origin |
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

## Limits

- `llama-server` runs with `--parallel 1`. One long generation blocks the next
  request, so a client can wait behind another session's turn. Raise `--parallel`
  in `scripts/llama-model.sh` (and accept the context split) if that matters more
  than per-request speed.
- The MCP server does not stream: `gateway_chat` is one non-streaming call.
- No write tools. Provider/model admin operations stay in the admin API and the
  dashboard, where the token and the audit line already exist.
