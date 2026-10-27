# Live check

`server/tools/live-check.ts` calls the real engines through the real gateway. The
fixture suite (`server/test/gateway.test.ts`) proves the gateway's error handling
by faking the upstream; this script proves the other half — that a fresh boot, a
real catalogue, real tokens, a real stream and a real shutdown still work.

It is a check, not a demo: every line is `PASS`, `FAIL` or `SKIP`, a `SKIP` always
prints why, and the process exits 1 if anything fails.

## Running it

```bash
cd server

# boot a throwaway gateway and use Ollama on 127.0.0.1:11434
node tools/live-check.ts

# add three timed non-stream requests
node tools/live-check.ts --soak=3

# ten minutes of streaming: p95 latency, largest chunk gap, RSS slope
node tools/live-check.ts --soak-minutes=10

# point it at a gateway that is already running
node tools/live-check.ts --base-url=http://127.0.0.1:8787 --token=secret
```

Provider selection comes from the environment: if no `CP_*_KIND` variable is set,
the script assumes `CP_OLLAMA_KIND=ollama` with `http://127.0.0.1:11434`. Any
`CP_*` and `GATEWAY_POLICY` variables already in the shell are passed through, so
the same command works for llama.cpp (`CP_LLAMACPP_KIND=llamacpp`) and a cloud
`/v1` provider.

## What each probe proves

| Probe | Proves |
| --- | --- |
| gateway boot | a cold start reaches `/health` with a real DB and log file |
| catalogue | `/v1/models` carries at least one model, with context length and caps |
| non-stream chat | a real completion comes back with content and `usage` |
| stream chat | real SSE frames and exactly one `[DONE]` |
| count_tokens | `/v1/messages/count_tokens` answers before the wire |
| tool call | the engine emitted `finish_reason=tool_calls` and the arguments are valid JSON |
| client abort | the abort is recorded as `aborted +1`, `errors +0` |
| admin auth | 401 anonymous, 200 with the token |
| embeddings gate | 400 before the wire for a model without the `embeddings` cap |
| soak | requests keep working over time; reports p50/p95, max chunk gap, RSS slope |
| shutdown | `SIGTERM` exits promptly and `gateway.closed` is in the log |

## Model selection is deliberate

The catalogue is ranked, not taken in order: a model with `completion` and
without `thinking` wins, then the widest context. On this machine that picks
`ollama/qwen2.5:1.5b` over `ollama/deepseek-r1:1.5b`.

The first version of the script took the model with the biggest context —
`deepseek-r1:1.5b` — and reported `FAIL non-stream chat: empty content`. The log
said `completionTokens: 16` with `finish_reason=length`: the reasoning model had
spent the whole 16-token budget thinking. Nothing was broken in the gateway; the
check was asking a reasoning model to answer in 16 tokens and then blaming the
gateway when it could not. Ranking non-reasoning models first, and using 64
tokens, is the honest fix.

## The abort probe polls instead of racing

`client abort` first reported `FAIL: abort was not recorded` while the gateway log
showed the opposite:

```
01:40:13.100  chat.completed    (the call before the abort)
01:40:13.813  chat.client_aborted  durationMs 710
```

The metrics request had been sent at ≈13.1 s — before the gateway's abort handler
wrote the row. The probe now reads a baseline, then polls `/admin/metrics` for up
to 10 s until `aborted` increases, and asserts `errors` did not change with it.
A fixed sleep would have been slower and no more correct.

## Recorded run — 2026-10-27, Ollama 0.35.1

`qwen2.5:1.5b` (ctx 32768, caps `completion+tools`), Node 24.19.0.
`node tools/live-check.ts --soak=3`:

```
PASS  gateway boot        469 ms  http://127.0.0.1:40731
PASS  catalogue             7 ms  2 models; using ollama/qwen2.5:1.5b (ctx 32768, caps completion+tools)
PASS  non-stream chat    6596 ms  content "OK"; usage 170/2
PASS  stream chat         128 ms  3 data frames, one [DONE]
PASS  count_tokens          5 ms  172 tokens, estimated=true
PASS  tool call          4296 ms  finish_reason=tool_calls, get_weather(city="Dhaka")
PASS  client abort        813 ms  aborted +1, errors +0
PASS  admin auth            5 ms  401 without token, 200 with token
PASS  embeddings gate       5 ms  400 before the wire (no embeddings capability)
PASS  soak x3            1199 ms  min 338 ms, avg 399 ms, p95 515 ms, max 515 ms
PASS  shutdown             16 ms  16 ms, gateway.closed logged

11 checks: 11 pass, 0 fail, 0 skip
```

`--soak-minutes=0.5` exercises the same path with the longer measurement:

```
PASS  soak 0.5 min      30074 ms  79 streams, 0 failed; p50 356 ms, p95 525 ms,
                                  max gap 83 ms; RSS 101.9 → 102.8 MB (+1.21 MB/min)
```

Thirty seconds is far too short to call a memory slope; the number is here to
show the measurement path works, not to claim stability.

Ten minutes of continuous streaming (`--soak-minutes=10`, `EXIT=0`):

```
PASS  soak 10 min      600651 ms  1113 streams, 0 failed; p50 435 ms, p95 1196 ms,
                                  max gap 152 ms; RSS 103.1 → 102.7 MB (-0.25 MB/min)
```

1113 streams with no failure; RSS ended 0.4 MB **below** where it started, so the
fitted slope is flat within noise over this window. The largest gap between
chunks was 152 ms — no stall. This is a 10-minute run: the S7 gate asks for 30
minutes, and that has not been run (`--soak-minutes=30` supports it).

## What this does not prove

- Answer quality. It asserts "content is not empty", nothing about accuracy.
- Cloud providers. Only the engines configured in `CP_*` are touched; the last
  recorded run used Ollama.
- Embeddings success. The gate (400 before the wire) is asserted, not a real
  vector, because no embedding model is installed.
- Images, audio, `/v1/messages` and policy/sanitizer headers. Those have their own
  documents ([`SANITIZE.md`](SANITIZE.md), [`POLICY.md`](POLICY.md),
  [`CONTEXT.md`](CONTEXT.md)) and fixture coverage.
- TLS. The script speaks plain HTTP to `127.0.0.1`.
- A 30-minute soak. The 10-minute run is recorded above; the 30-minute gate in
  [`STEPS.md`](STEPS.md) is still open.
