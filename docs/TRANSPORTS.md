# Transport matrix — evidence

Scope: which transport actually carries a chat completion into a local or remote
inference engine, and what the gateway therefore implements.

| Transport | Reality on the wire | Evidence | Gateway decision |
| --- | --- | --- | --- |
| HTTP/1.1 + SSE | The only universally implemented inference transport. Request is JSON, response is `text/event-stream` when `stream: true`. | `llama.cpp tools/server/README.md` ("Server-sent events standard"); Ollama OpenAI compatibility page (`/v1/chat/completions`, `stream`); `@ai-sdk/openai-compatible` d.ts (`includeUsage`) | Implemented (`src/transport/request.ts`) |
| HTTPS/TLS | Same framing over TLS. Certificate verification is mandatory; engines that need a self-signed cert must be reached through a local reverse proxy. | Node `https` defaults, `rejectUnauthorized` never disabled in this codebase | Implemented |
| UDS / AF_UNIX | Real and useful locally: no TCP handshake, socket-file permissions gate access. | `llama-server --host` accepts "UNIX socket paths ending in `.sock`" (llama.cpp server README) | Implemented (`socketPath`) |
| WebSocket | Exists on llama-server only as `/v1/realtime` for **audio transcription**, not chat. | same README, "WebSocket `/v1/realtime`: Realtime transcription" | Rejected for chat with HTTP 501 |
| gRPC | Used by serving stacks such as Triton, never by OpenAI-compatible endpoints. | no OpenAI-compatible gRPC contract exists | Not implemented |
| stdio | Belongs to MCP tool servers and CLIs. Model inference never travels over stdio. | `stdioMcpServer` in this repo is an MCP config, not an inference config | Not implemented |
| Shared memory / memcached IPC | **Does not exist** for Ollama or llama.cpp inference. There is no memory-mapped ring buffer to subscribe to. | no such endpoint or flag in either server; llama-server exposes only HTTP routes | Not implemented |
| mmap (model weights) | llama.cpp maps the GGUF file by default, so two processes share the same page cache. This is OS-level sharing of *weights*, not a request transport and not a cache you can query. | llama.cpp `--no-mmap` flag exists precisely because mmap is the default | No action needed |
| Prompt cache | The real reuse mechanism: llama-server keeps per-slot prompt caches (`/slots/{id}?action=save|restore`) and Ollama keeps the model plus KV state loaded for a keep-alive window. | llama.cpp README slot endpoints; Ollama `/api/ps` (`expires_at`) | Handled by keeping the engine warm, not by a gateway cache |

## Why the shared-memory idea must be dropped

Reading inference output "from the same memory port without a TCP handshake" would
require the engine to publish a shared-memory ring buffer. Neither Ollama nor
llama-server does. What they do offer is:

1. `--host /path/to.sock` — a unix socket, which removes TCP but is still an IPC
   stream, and is the closest thing to "no network" that exists here.
2. mmap of the model file — shared read-only pages, invisible to request routing.
3. Slot prompt cache — avoids recomputing the prompt, not the response.

A gateway that pretends to read shared memory would have to implement a protocol
the server does not speak. The honest implementation is: HTTP, HTTPS, UDS.

## What popular clients actually do

| Client | How it reaches a local model | Note |
| --- | --- | --- |
| OpenCode | Provider entry with `npm: "@ai-sdk/openai-compatible"` + `baseURL` (its own provider docs list `llama.cpp` and `Ollama` this way) | stdio is used for MCP, not inference |
| Claude Code | Anthropic Messages API through a gateway base URL; the docs state non-Claude models are not supported through that path | needs `/v1/messages`, not chat-completions |
| KiloCode / Cline family | OpenAI-compatible base URL over HTTP + SSE | same shape this gateway exposes |
| LM Studio | HTTP server on `:1234/v1` | OpenAI-compatible |
| vLLM | HTTP OpenAI server; UDS support was requested in issue #13907 (closed 2025-08-08) | HTTP is the safe assumption |

## Consequence for this gateway

- Clients speak HTTP/1.1 + SSE to the gateway. That is one code path and it is
  the only one every client supports.
- The gateway speaks HTTP/1.1 to the engine, optionally over UDS.
- TLS termination belongs in front of the gateway (Nginx/Caddy), not inside every
  provider adapter.
- Anthropic-shaped clients are a translation layer added later at
  `/v1/messages`; they are not a transport.

## Copy, map, handshake — three different costs

The word "transport" hides three mechanisms that are not comparable:

| Mechanism | What the CPU does | Copies | Can the gateway use it? |
| --- | --- | --- | --- |
| `mmap` of the GGUF | maps file pages into the process; faults them in on demand | **0** | No — it is engine-internal weight residency, not a request channel |
| Unix domain socket | `sendmsg` into the peer's receive buffer, scheduler wakeup | **1** (kernel copy) | Yes — `socketPath` in `server/src/transport/request.ts` |
| TCP loopback | socket buffer + loopback stack traversal | 1 + stack | Yes — default |
| TLS over either | record encrypt/decrypt + a handshake per connection | +CPU per byte | Terminated in front (Nginx/Caddy), not per adapter |

Measured on this machine (curl against the local bridge, three runs each):

```text
tcp connect=0.000119 total=0.000522
tcp connect=0.000120 total=0.000582
tcp connect=0.000122 total=0.000425
uds connect=0.000050 total=0.000666
uds connect=0.000059 total=0.001066
uds connect=0.000055 total=0.001015
```

Inference on the same host measured 639–6762 ms per request (`request_logs`
`ttfb_ms` / `duration_ms`). The transport difference is therefore about **0.01% of
wall clock** — real, but not the thing that makes a model slow.

So the honest ranking is:

1. **Residency** decides whether the first token costs 0.3 s or 30 s.
2. **Prompt cache / KV reuse** decides whether turn N re-reads the whole context.
3. **Queue depth** decides whether a second request waits or fails.
4. **Transport** decides *who can reach the socket*, and only then, marginally,
   latency.

That is why UDS is implemented as a **headless** path: no listening TCP port, no
port-forwarding, access governed by the socket file's owner/group/mode. mmap stays
where it belongs — inside the engine, configured by `OLLAMA_KEEP_ALIVE` and
`use_mmap`, observed through `/proc/<pid>/smaps`, never pretended to be an API.
