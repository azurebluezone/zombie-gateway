# Prompt hygiene — the sanitizer

An SDK payload, a pasted document or a model answer can carry characters that
are invisible to the person reading them but meaningful to a machine. They are
used three ways:

1. **Watermarking** — a run of zero-width joiners encodes an identity claim.
2. **Hidden instructions** — the Unicode tag block (`U+E0000`–`U+E007F`) maps
   one-to-one onto ASCII, so a whole sentence can hide inside a "clean" prompt.
3. **Plain bugs** — a zero-width joiner inside an identifier makes two
   identical-looking strings unequal, which breaks tool names and schema keys.

The gateway treats every such character as **data noise, never as signal**. It
does not interpret the content around it and it does not follow instructions
found inside it.

## Policy: report before remove

The scan counts what it found, by kind, before anything is dropped. Removal is
never silent: the counts travel back in `x-sanitize` / `x-sanitize-output`, and a
non-clean prompt writes a `sanitize.prompt` log line.

What survives, and why:

| Character | Decision |
| --- | --- |
| ZWJ / ZWNJ (`U+200D` / `U+200C`), **single**, between two letters/marks of a joining script (Bengali, Arabic/Persian, other Indic, Khmer, Mongolian, Hangul) or between emoji | **Kept.** These scripts need it for shaping (`ক্‌ষ`, `می‌خواهم`, 👨‍👩‍👧). |
| A single ZWNJ between Latin/Cyrillic/Greek letters | Removed. No such language uses it for shaping; it is a carrier. |
| ZWSP (`U+200B`) | Removed. No orthography uses it. |
| Any run of 2+ zero-width characters | Removed. No orthographic reading. |
| Unicode tag block (`U+E0000`–`U+E007F`) | Removed, counted as `unicode-tag`. |
| Bidi controls (`U+202A`–`U+202E`, `U+2066`–`U+2069`, LRM/RLM, ALM) | Removed, counted as `bidi-control` (Trojan Source). |
| Word joiner and invisible operators (`U+2060`–`U+2064`, `U+206A`–`U+206F`) | Removed. |
| Hangul fillers (`U+115F`, `U+1160`, `U+3164`, `U+FFA0`, `U+180E`) | Removed. |
| Soft hyphen (`U+00AD`), BOM (`U+FEFF`) | Removed. |
| Control bytes (`< 0x20` except tab/LF/CR, `0x7F`, `0x80`–`0x9F`) | Removed. |
| 40 %+ of lines ending in two spaces | Flagged `trailing-mark` (markdown side channel), text unchanged. |

Two thresholds make a report actionable:

- `runs` — two or more consecutive zero-width characters.
- `hiddenPayload` — eight or more consecutive invisible characters of any kind.

A JSON key whose cleaned form collides with an existing key keeps both keys and
sets `keyCollision`; the gateway never resolves a collision by dropping a field.

Request bodies deeper than 64 levels are rejected with `400` instead of walked:
an unbounded recursive walk over attacker-supplied JSON is a stack-exhaustion
vector, and no chat payload legitimately nests that deep.

## Modes

| `GATEWAY_SANITIZE` | Behaviour |
| --- | --- |
| `strip` (default) | Scan, report, remove. |
| `report` | Scan and report; bytes are untouched. |
| `off` | Do not scan at all (`x-sanitize: off`). |

An unknown value fails at boot. A silent fallback would let an operator believe
`off` was active while the gateway kept editing prompts.

## Where it runs

| Surface | Prompt | Response |
| --- | --- | --- |
| `/v1/chat/completions` | full body, keys included | non-stream: cleaned, counted in `x-sanitize-output`; stream: scanned, logged, delivered bytes untouched |
| `/v1/messages` | full body | translation of the cleaned body; text is the engine's |
| `/v1/messages/count_tokens` | full body | — |
| `/v1/embeddings` | every input string | vectors untouched |

Streamed text is **scanned but not rewritten**: a carrier can straddle two
chunks, and judging half a ZWJ pair would either strip real orthography or let
the other half through. The assistant copy written to session history is
cleaned, so the next turn does not replay the payload.

## What this does not cover

- **Confusables and homoglyphs** (Cyrillic `а` vs Latin `a`). They are visible
  characters and removing them would corrupt legitimate text.
- **Statistical watermarks** in word choice. Not detectable at the byte level.
- **Images, audio and base64 blobs.** The sanitizer is a string walker.
- **Admin request bodies.** Admin input is authenticated; it is not cleaned.
- **Client-side rendering.** The gateway cleans what it forwards, not what a
  browser already drew.

## Tests

```bash
cd server && node --test test/sanitize.test.ts
```

24 cases: Bengali/Persian/emoji orthography survives, a Latin ZWNJ is
removed, ZWSP and tag payloads are removed, report mode edits nothing, `off`
does not scan, double sanitising is a no-op, key collisions keep both keys,
empty reports do not share state, 70-deep JSON is rejected and 60-deep passes.

Measured on 2026-10-26 (Ollama 0.35.1, `qwen2.5:1.5b`):

```
POST /v1/messages  system:"normal\0text" + 8 tag chars
  → 200, x-sanitize: control-byte:1,unicode-tag:8;hidden-payload
  → sanitize.prompt detected:9 removed:9 hiddenPayload:true
POST /v1/messages  content:"hello\u200bworld"
  → 200, x-sanitize: zero-width:1
POST /v1/chat/completions  content:"ক্‌ষ"  (ZWNJ)
  → 200, detected:1 removed:0     # orthography preserved
```
