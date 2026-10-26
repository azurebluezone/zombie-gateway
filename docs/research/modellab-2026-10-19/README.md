# Model Lab research — evidence index

Source device: `/media/sahon/343438FD3438C3A0/ZombieCoder-ModelLab-Research/`
(copied, originals untouched). Hashes in `PROVENANCE.txt` match the originals
one-to-one, so every citation below is byte-identical to the archived run.

## Claims and where they are proven

| Claim | Evidence |
| --- | --- |
| llama.cpp / Ollama weights are mapped `MAP_SHARED` when `use_mmap=true`, 1.87 GB vs 0 B when disabled | `HANDOVER.md:32-33` (table header `:30`) |
| Kernel config used for the run: `OLLAMA_KEEP_ALIVE=-1`, `OLLAMA_MAX_LOADED_MODELS=2`, explicit `OLLAMA_CONTEXT_LENGTH=8192` | `environment.md:69-74` |
| Marker→JSON fallback chain exists and is ordered | `project/model_tools.py:440,475,598,621` |
| Learned-dialect precision on synthetic families: 5 dialects, coverage 21/21, LOO 21/21, false positives 0 | `HANDOVER.md:75` |
| Single grammar baseline 9/21 vs hand-written chain 15/21 | `HANDOVER.md:76-77` |
| Real models: `llama3.2` 5/5 native, `qwen3.5:0.8b` 4/5, `deepseek-r1:1.5b` 0/5 | `HANDOVER.md:78` |
| Per-model learned dialect and LOO score, persisted | `project/lab_data/dialect_memory.json:5,70` (deepseek 0.0), `:73,138` (qwen3.5 0.8), `:141,182` (llama3.2 1.0) |
| Tool executions are real, not simulated (51 rows with exit codes and byte counts) | `project/tool_calls.jsonl:1,3` (51 lines) |
| Round-loop failure is unresolved: 6 rounds, 1012 tokens, 216.62 s, no file produced | `HANDOVER.md:106-107` (section `:102`), status row `:16,163` |

## What is NOT evidence here

- `local-llm-bridge.js` is **not** in this repository. It was observed as a running
  process outside the allowed root and must not be cited as a project file.
- The archive numbers come from a different machine (Ollama 0.40.6, three models).
  This machine runs Ollama 0.35.1 with two models, so the archive is
  `SOURCE_VERIFIED`, not re-measured locally.

## Decision under review

When to probe a model's tool dialect.

- Option A — probe during catalogue sync: fresh scores, but a cold sync blocks for
  minutes and multiplies with every provider.
- Option B — probe lazily on first tool request, persist the result, re-probe only
  when the model id or upstream version changes: first caller pays once.

Recommendation: **B**, with `dialect.updated_at` + `model.upstream_version` as the
invalidation key. Evidence that caching is safe: `dialect_memory.json` shows the
dialect is stable per model across the whole probe set, and the LOO score is a
property of the model, not of the request.
