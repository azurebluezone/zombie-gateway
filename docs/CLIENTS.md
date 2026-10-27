# Transport: how other projects talk to this gateway

This file is the contract. Any project that needs an OpenAI-compatible endpoint
points at **this** server; nothing else in the workspace should re-implement the
translation, the catalogue or the provider credentials. The evidence for *which*
transports are real (and why WebSocket/shared-memory are not) lives in
`docs/TRANSPORTS.md`; this file is the how-to.

```
client project ──HTTP (127.0.0.1:5252)──► gateway ──HTTP/HTTPS/UDS/WS──► engine
client project ──UDS (gateway.sock)────► gateway
```

One process, one routing table, one SQLite catalogue. The listener choice only
changes how bytes arrive, never which routes exist:

| Listener | Enabled by | Default | Access |
| --- | --- | --- | --- |
| TCP | `GATEWAY_PORT` | none — port is env-only | `GATEWAY_HOST` (default `127.0.0.1`) |
| Unix socket / named pipe | `GATEWAY_SOCKET` | unset (off) | socket file mode `GATEWAY_SOCKET_MODE` (default `660`) |

At least one listener must be configured. There is no compiled-in port: boot
fails with a clear message when `GATEWAY_PORT` and `GATEWAY_SOCKET` are both
empty (`server/src/config.ts`, `readPort`).

## 1. Public routes

Identical over both listeners:

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health`, `/healthz` | liveness, provider/model counts |
| `GET` | `/v1/models` | OpenAI model list, ids are `<provider>/<model>` |
| `GET` | `/v1/providers` | provider view (kind, transport, enabled) |
| `POST` | `/v1/chat/completions` | chat, streaming and non-streaming |
| `POST` | `/v1/embeddings` | embeddings (provider must support them) |
| `POST` | `/v1/messages` | Anthropic Messages, stateless translation |
| `POST` | `/v1/messages/count_tokens` | token estimate, no upstream call |
| `GET` | `/admin/*` | JSON admin surface, same port, one auth switch |

Admin lives on the same listener on purpose: no second process, no second port,
no second auth story. See `docs/ADMIN-API.md`.

### Authentication

The **public** routes have no auth of their own. The boundary is the listener:

- TCP binds `127.0.0.1` by default — not reachable from another machine.
- A Unix socket is guarded by its file mode (`660` = owner and group only).

If you bind `GATEWAY_HOST=0.0.0.0`, put a reverse proxy with auth in front of it.
Send an `Authorization: Bearer <anything>` header if your client insists on one;
the gateway ignores it on public routes and never forwards it upstream (upstream
keys come from `CP_<ID>_API_KEY`).

## 2. Calling over TCP

The base URL an OpenAI SDK wants is the server root **plus** `/v1`:

```bash
# shell
export OPENAI_BASE_URL=http://127.0.0.1:5252/v1
export OPENAI_API_KEY=local
```

```bash
curl -s http://127.0.0.1:5252/health
curl -s http://127.0.0.1:5252/v1/models | jq -r '.data[].id'
```

```bash
curl -s http://127.0.0.1:5252/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "ollama/qwen2.5:1.5b",
    "messages": [{"role": "user", "content": "Say ready."}],
    "max_tokens": 16
  }'
```

Streaming is plain SSE; `[DONE]` is the last frame, and an upstream that dies
mid-body ends with one `error` frame instead of a fake completion:

```bash
curl -N http://127.0.0.1:5252/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"ollama/qwen2.5:1.5b","stream":true,
       "messages":[{"role":"user","content":"count to three"}]}'
```

### Python

```python
from openai import OpenAI          # any OpenAI-compatible client works

client = OpenAI(base_url="http://127.0.0.1:5252/v1", api_key="local")
print(client.chat.completions.create(
    model="ollama/qwen2.5:1.5b",
    messages=[{"role": "user", "content": "Say ready."}],
    max_tokens=16,
).choices[0].message.content)
```

### Node

```js
const res = await fetch("http://127.0.0.1:5252/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "ollama/qwen2.5:1.5b",
    messages: [{ role: "user", content: "Say ready." }],
    max_tokens: 16,
  }),
});
console.log((await res.json()).choices[0].message.content);
```

## 3. Calling over a Unix socket (Linux, macOS, WSL)

Enable it in `server/.env`:

```bash
GATEWAY_SOCKET=./data/gateway.sock    # relative paths resolve against server/
GATEWAY_SOCKET_MODE=660
```

The file is created on listen, `chmod`ed to the configured mode, removed on
graceful shutdown, and only unlinked after a 300 ms probe proves no other
gateway is answering on it.

`curl` is the shortest check:

```bash
curl -s --unix-socket ./data/gateway.sock http://localhost/health
curl -s --unix-socket ./data/gateway.sock http://localhost/v1/models
curl -s --unix-socket ./data/gateway.sock http://localhost/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"ollama/qwen2.5:1.5b","messages":[{"role":"user","content":"hi"}],"max_tokens":8}'
```

The `Host` header is irrelevant; it is a local path, not DNS.

### Node, no dependency

`http.request({ socketPath })` is the whole recipe (this is what
`server/test/gateway.test.ts` uses):

```js
import { request } from "node:http";

const body = await new Promise((resolve, reject) => {
  const call = request(
    { socketPath: "/absolute/path/gateway.sock", path: "/v1/models", method: "GET" },
    (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => resolve(JSON.parse(text)));
    },
  );
  call.on("error", reject);
  call.end();
});
console.log(body.data.map((m) => m.id));
```

### Python, no dependency

`http.client` plus a connected Unix socket; no `requests-unixsocket` needed:

```python
import http.client, json, socket

class UDSConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost")
        self._uds_path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.connect(self._uds_path)

conn = UDSConnection("/absolute/path/gateway.sock")
conn.request("POST", "/v1/chat/completions",
             body=json.dumps({"model": "ollama/qwen2.5:1.5b",
                              "messages": [{"role": "user", "content": "hi"}],
                              "max_tokens": 8}),
             headers={"content-type": "application/json"})
print(json.loads(conn.getresponse().read()))
```

With `httpx`, the same thing is one line, and the OpenAI SDK accepts that client:

```python
import httpx
from openai import OpenAI

http_client = httpx.Client(transport=httpx.HTTPTransport(uds="/absolute/path/gateway.sock"))
client = OpenAI(base_url="http://localhost/v1", api_key="local", http_client=http_client)
```

### Which clients can use a socket at all

| Client | UDS | Notes |
| --- | --- | --- |
| `curl` | yes | `--unix-socket` |
| Node `http`/`https` | yes | `socketPath` option |
| Python `http.client` / `httpx` | yes | recipe above |
| Go `net/http` | yes | `DialContext` with `net.Dial("unix", path)` |
| Rust `reqwest` | yes | `ClientBuilder::unix_socket` |
| Browsers, most GUI apps, OpenAI JS SDK defaults | no | use the TCP loopback URL |

If your tool cannot dial a socket, use `http://127.0.0.1:5252/v1`. That is not a
downgrade: the loopback interface never leaves the machine either.

## 4. Windows: named pipes instead of socket files

Windows has no `AF_UNIX` path semantics that Node exposes as a file. Set a pipe
name:

```powershell
$env:GATEWAY_SOCKET = '\\.\pipe\gateway'
$env:GATEWAY_PORT = '5252'
npm start
```

- A filesystem path in `GATEWAY_SOCKET` on Windows is rejected at boot with an
  explicit message; it is not silently ignored.
- `GATEWAY_SOCKET_MODE` is ignored (no file, no mode); access control comes from
  the pipe ACL.
- `curl --unix-socket` does not speak named pipes. Use a Node/Python client with
  `socketPath` / `AF_PIPE`, or just use the TCP URL.
- `GATEWAY_DB`, `GATEWAY_LOG`, `GATEWAY_DATA_DIR` accept `C:\gateway\data.db`
  and forward slashes equally. Keep them on a local disk; SQLite locking over a
  network share is not supported behaviour.

## 5. Outbound: what the gateway speaks to engines

Each provider is configured independently; the transport is a per-provider
field, not a global mode.

| `CP_<ID>_TRANSPORT` | Required fields | Example |
| --- | --- | --- |
| `http` (default) | `BASE_URL` | `CP_OLLAMA_BASE_URL=http://127.0.0.1:11434` |
| `https` | `BASE_URL` | `CP_CLOUD_BASE_URL=https://api.example.com/v1` |
| `uds` | `BASE_URL` + `SOCKET` | `CP_LLAMA_SOCKET=/run/llama.sock` |
| `ws` | — | accepted by the parser but rejected at boot with `unsupported_transport` (501): WebSocket is not an inference transport here |

The evidence behind that last row is in `docs/TRANSPORTS.md`.

`MODELS` adds ids the engine does not list — this is what makes an env-only
deployment work when `/models` is missing or empty:

```bash
CP_CUSTOM_KIND=openai
CP_CUSTOM_BASE_URL=https://api.example.com/v1
CP_CUSTOM_API_KEY=sk-...
CP_CUSTOM_MODELS=gpt-4o-mini,text-embedding-3-small
```

### TLS

Outbound `https` uses Node's default verification. There is no switch to skip
it, and `NODE_TLS_REJECT_UNAUTHORIZED=0` is not part of this project's contract.

- Public CA: nothing to configure.
- Private CA: `NODE_EXTRA_CA_CERTS=/etc/ssl/private-ca.pem` in the service
  environment, once, at boot.
- Inbound TLS is **not** terminated here. Put Caddy/nginx in front:

```nginx
server {
  listen 443 ssl;
  server_name gateway.internal;
  ssl_certificate     /etc/ssl/gateway.crt;
  ssl_certificate_key /etc/ssl/gateway.key;

  location / {
    proxy_pass http://127.0.0.1:5252;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;          # SSE must not be buffered
    proxy_read_timeout 600s;      # a cold model load is slow, not broken
  }
}
```

`proxy_buffering off` matters: with it on, streaming responses arrive in one
burst when the generation ends.

## 6. Using this gateway from another project

The other project needs three values and no code:

```bash
OPENAI_BASE_URL=http://127.0.0.1:5252/v1   # or http://gateway.internal/v1
OPENAI_API_KEY=local                       # public routes ignore it
# model: <provider>/<model>, e.g. ollama/qwen2.5:1.5b
```

Checklist before pointing a project here:

1. `curl -s http://127.0.0.1:5252/health` returns `"status":"ok"`.
2. `curl -s http://127.0.0.1:5252/v1/models` lists the model id you intend to use.
3. The model id includes the provider prefix; `qwen2.5:1.5b` alone will 404 with
   `model_not_found` and a pointer to the catalogue.
4. Ask for the capability you need: tool calling and embeddings are advertised
   per model in `GET /v1/models`; a provider that lacks them returns a typed
   error instead of a malformed upstream call.

UDS-only deployments replace step 1 with:

```bash
curl -s --unix-socket /path/gateway.sock http://localhost/health
```

and set the client's socket path instead of a URL. Everything after the
transport — routing, translation, catalogue, logging — is unchanged.
