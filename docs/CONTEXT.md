# Context-window ledger

A context window is a hard number owned by the engine, not by the gateway. The
failure this module prevents is the quiet one: a prompt that is slightly too
long, an engine that silently drops the middle, and an answer that looks
healthy while the instruction was never seen.

Everything below is published on the response. A number the client cannot see
is a number the client cannot argue with.

## The arithmetic

```
total = prompt_estimate + message_overhead + tools_estimate
      + image_estimate + reserve
```

| Component | Source |
| --- | --- |
| `prompt_estimate` | `ceil(ascii/4 + non-ascii/2)`, applied per character class and summed per message content |
| `message_overhead` | 4 tokens × message count (role markers and separators) |
| `tools_estimate` | the same character heuristic on the JSON tool schemas |
| `image_estimate` | images × 1024 (a bound, not a measurement) |
| `reserve` | `max(client max_tokens, policy reserve)` |

The estimator is **not** a tokenizer. It does not ship a BPE table and never
claims exactness: `x-context-prompt-estimate` is a number with "estimate" in the
name, and `/v1/messages/count_tokens` returns `estimated: true` with a note.

## The limit

`models.context_length` from the catalogue is the only limit the gateway
enforces. The catalogue fills it from the engine's own report — Ollama
`/api/tags` → `details.context_length`, llama.cpp `/props` →
`default_generation_settings.n_ctx`, OpenAI-compatible `/models` when the field
exists.

| Situation | Behaviour |
| --- | --- |
| length known, `total > limit`, enforcement on | `400 context_length_exceeded`, headers included |
| length known, enforcement off (`GATEWAY_CONTEXT_ENFORCE=0`) | request runs; `x-context-overflow-by` says by how much |
| length unknown | not enforced; `x-context-limit: unknown`, `x-context-limit-source: unknown` |

Unknown is never replaced by an assumed number. A guarantee invented by the
gateway is worse than an admitted gap.

## Reserve

`GATEWAY_OUTPUT_RESERVE` is a **floor**, not a cap. A client that asks for
`max_tokens: 40000` is counted as 40000 even when the floor is 64, because
under-counting the client's own request would hide a real overflow. With no
explicit value the reserve is derived from the window:

```
reserve = clamp(limit / 8, 256, 8192)
```

## Drift: when the estimate is wrong

After a response, the engine's own `usage.prompt_tokens` is compared with the
estimate:

- `x-context-estimate-ratio` = actual ÷ estimate.
- `x-context-estimate-drift: 1` (and a `context.estimate_drift` log line) when
  the prompt is longer than 512 tokens and the actual is more than 1.6× the
  estimate.
- `context.upstream_overflow` (error level) when `prompt + completion` exceeded
  a known window — evidence that the engine truncated instead of refusing.

A ratio near 1 on a long prompt means the estimator is usable for this model. A
large ratio means it is not, and the header says so instead of smoothing it
over. Short prompts always show a large ratio because the engine's chat template
adds tokens the estimator never sees; that is why drift needs 512 tokens before
it fires.

When the engine reports no usage, the gateway's estimate is left in place and no
ratio is claimed — an estimate compared with itself would always look healthy.

## Streaming

Anthropic-shaped streams need `usage` in `message_start`, which is sent before
any token arrives. That first number is the gateway estimate. When the engine
reports usage during the stream, the closing `message_delta` carries the real
`input_tokens` and `output_tokens`. A client reading only `message_start` gets a
budget number, not a measurement.

## What the ledger does not do

- **No trimming.** Long sessions are refused, not silently shortened. If a
  session no longer fits, trim it in the client or start a new one; the error
  message prints every component so the cut is obvious.
- **No tokenizer.** Exact counting would require a per-model BPE table, which
  is a dependency this gateway does not take.
- **No stream pre-check on partial text.** The plan is computed from the full
  prompt before the upstream call; incremental tool loops re-plan on the next
  request.

## Measured on 2026-10-26 (Ollama 0.35.1, `qwen2.5:1.5b`, ctx 32768)

```
max_tokens 40000, enforce on
  → 400, x-context-reserve: 40000, x-context-overflow-by: 7237
     "prompt ~5 + tools ~0 + images ~0 + reserve 40000 = 40005, limit 32768"
max_tokens 40000, enforce off
  → 200, x-context-overflow-by: 7237
max_tokens 8, GATEWAY_OUTPUT_RESERVE=64
  → x-context-reserve: 64
simple prompt
  → x-context-prompt-estimate: 7, x-context-actual: 32, ratio 4.57 (under 512, no drift flag)
```
