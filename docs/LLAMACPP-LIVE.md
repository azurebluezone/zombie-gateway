# llama.cpp — what was actually run

This file exists because the gateway's llama.cpp driver was written from the
documented `/v1` contract and, until 2026-10-26, had never been executed against
a real `llama-server`. It has now. Nothing below is a plan; each block is a
command whose output is quoted.

## What was on the disk

The mounted drive `/media/sahon/759e9d2f-…/` turned out to hold a full Linux root
with an **already compiled** llama.cpp, so no download or build was needed:

```
$ ls -la /media/sahon/…/home/sahon/src/llama.cpp/build/bin/llama-server
-rwxrwxr-x 1 sahon sahon … llama-server
$ LD_LIBRARY_PATH=…/build/bin …/build/bin/llama-server --version
version: 0.7.0-dev (build 1, commit 620d222)
built with GNU 11.4.0 for Linux x86_64
```

`CMakeCache.txt`: `CMAKE_BUILD_TYPE=Release`, `GGML_CUDA=OFF` — a CPU build.
The binary is **modular** (`libllama-server-impl.so`, `libllama.so`, …), and the
build does not set an rpath, so it only starts with `LD_LIBRARY_PATH` pointing at
`build/bin`. A distro package does not have this quirk.

Model: `Qwen3-4B-Instruct-2507-Q4_K_M.gguf` (2.5 GB), `-c 4096 -t 4 --no-webui`.

## HTTP

```
$ llama-server -m Qwen3-4B-Instruct-2507-Q4_K_M.gguf --host 127.0.0.1 --port 8091 -c 4096 -t 4
… llama_server: model loaded
… llama_server: listening on http://127.0.0.1:8091        # 14.2 s from start

$ curl -s http://127.0.0.1:8091/props | jq '.default_generation_settings.n_ctx'
4096
```

Note: this build answers `/v1/models` with **both** `models` and `data`, and the
id is an absolute filesystem path. The driver therefore derives the public model
id from the basename; exposing the path would leak the mount point to every
client.

## Unix socket

```
$ llama-server -m … --host /tmp/opencode/llama.sock -c 2048 -t 4 --no-webui
… llama_server: listening on unix:///tmp/opencode/llama.sock

$ curl -s --unix-socket /tmp/opencode/llama.sock http://localhost/health
{"status":"ok"}
```

The gateway reaches the same socket with `CP_*_TRANSPORT=uds`; the transport
sends `host: localhost` because HTTP/1.1 requires a Host header even when there
is no network.

## Through the gateway

```
$ curl -s http://127.0.0.1:8814/v1/models
llama/qwen3-4b-instruct-2507-q4_k_m.gguf | ctx: 4096 | caps: ["completion","tools"]

POST /v1/chat/completions  {"messages":[{"role":"user","content":"Say ready in five words."}]}
HTTP/1.1 200 OK
x-context-limit: 4096
x-context-limit-source: catalog
x-context-reserve: 512
x-context-actual: 14
x-context-estimate-ratio: 1.40
{"content":"Got it, ready to go!","usage":{"prompt_tokens":14,"completion_tokens":8}}
```

Tool calling is native and clean on this template — the known Qwen2.5-via-Ollama
schema echo did **not** appear:

```
POST /v1/chat/completions  tools=[get_weather]
finish: tool_calls
tool_calls: [{"type":"function","function":{"name":"get_weather",
             "arguments":"{\"location\": \"Dhaka\"}"}}]
```

Over the socket the same request answered `'Ready, go! ✅'` with
`x-context-limit: 2048`, which is the second instance's `-c`.

Streaming produced the expected SSE shape (9 `data:` frames, a final `[DONE]`),
and the closing frame carried llama-server's own `timings` object, which the
gateway does not rewrite.

## What this does and does not prove

Proved: the driver's discovery (`/props` + `/v1/models`), context-length
mapping, chat, streaming, native tool calls, and both transports.

Not proved: GPU offload (this build is CPU-only), prompt-cache slot reuse,
`/v1/embeddings` (no embedding model on the machine), and any llama.cpp version
other than 0.7.0-dev at commit `620d222`. A different build can change
`/v1/models`' key names again; the driver already falls back to `/props` when the
list is empty for exactly that reason.

## If you need a binary on another machine

Prefer the official release archive for your platform over compiling: it is the
same code, built with the maintainers' flags, and it takes seconds instead of
tens of minutes. Pin the version, verify the published checksum, and keep it
outside the repository. Compile only when you need a flag the release does not
carry (a specific CUDA arch, ROCm, Vulkan, or `GGML_NATIVE=ON`).

## 2026-10-28 — Llama-3.2-1B-Instruct-abliterated, managed by a script

The GGUF lives in the Hugging Face cache; the file in `snapshots/` is a symlink
to `blobs/`, so the real path is resolved with `readlink -f` before anything
inspects `/proc/<pid>/maps`.

```
$ ls -l .../snapshots/becf3685…/Llama-3.2-1B-Instruct-abliterated.Q5_K_S.gguf
lrwxrwxrwx … -> ../../blobs/8ec986ecf3c74be3b031dc015e8f0feaaa3e1be28bc5b6c55296b48fa5cd224f
$ /home/sahon/src/llama.cpp/build/bin/llama-server --version
version: 0.7.0-dev (build 1, commit 620d222)
```

`server/scripts/llama-model.sh start|stop|restart|status|logs|url` is the only
way the model is launched. It runs `llama-server` with:

```
--model <gguf> --alias llama-3.2-1b-abliterated
--host 127.0.0.1 --port 8080 --ctx-size 4096 --threads 4 --parallel 1
--load-mode mmap --jinja --no-webui --metrics --log-jsonl
```

`--load-mode mmap` is explicit: the weights are a memory-mapped file, not an
anonymous heap copy. `--mlock` is opt-in (`LLAMA_MLOCK=1`) because pinning
1.2 GiB on a 16 GiB machine is a policy choice.

```
$ scripts/llama-model.sh start
started pid 38737, waiting for http://127.0.0.1:8080/health
healthy after 3s (pid 38737)

$ scripts/llama-model.sh status
pid:      38737
health:   up (http://127.0.0.1:8080/health)
model:    Llama-3.2-1B-Instruct-abliterated.Q5_K_S.gguf
n_ctx:    4096
slots:    1
models:   llama-3.2-1b-abliterated
rss:      1230 MiB
mmap:     yes (gguf mapped into the process)
```

`mmap: yes` is read from `/proc/<pid>/maps` (a shared `r--s` mapping of the blob),
not from the flag string.

### Logs

Everything lands in `server/logs/`:

| File | Content |
| --- | --- |
| `llama-server.jsonl` | Every line llama-server prints, `--log-jsonl`: load, slots, per-request timings. |
| `llama-model.log` | Supervisor lines from the script (`starting`, stop) and crash output. |
| `gateway.jsonl` | Gateway lifecycle and `chat.completed` / `chat.failed` with tokens and status. |
| `access.jsonl` | One line per HTTP request, success or failure, with `request_id`. |

### Transport conformance

`server/scripts/transport-check.mjs` sends seven real requests and validates the
wire shape, then checks that each `x-request-id` reached `logs/access.jsonl`:

```
PASS  openai.nonstream.http   {"transport":"http","request_id":"7675a19e…","tokens":194,"ms":835}
PASS  openai.stream.http      {"transport":"http","events":11,"done":true,"ms":1713}
PASS  openai.nonstream.uds    {"transport":"uds","request_id":"a583d6bf…","ms":856}
PASS  openai.stream.uds       {"transport":"uds","events":11,"done":true,"ms":1573}
PASS  anthropic.nonstream.http {"stop_reason":"end_turn","ms":863}
PASS  anthropic.stream.http   {"events":13,"ms":1753}
PASS  anthropic.stream.uds    {"events":13,"ms":1126}
14/14 checks passed
```

The unix socket is `/tmp/gateway.sock`, reachable through the stable symlink
`~/.local/share/zombie-gateway/gateway.sock`.

### Upstream stale-socket retry

One run failed with `502 provider_unreachable (ECONNRESET)` on
`anthropic.stream.uds`: Node reused a keep-alive socket the peer had already
closed, and it does not retry a POST. `attemptUpstream()` now retries once on a
fresh connection (`agent: false`) when the socket was reused, no response byte
arrived, and the code is `ECONNRESET`/`EPIPE`, logging
`upstream.retry_stale_socket`. The retry path is defensive: it has not been
forced in a test, so it is NOT_TESTED even though the surrounding check passes.
