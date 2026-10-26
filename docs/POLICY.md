# Behaviour layer — one policy, injected once

A gateway is a shared doorway. Models behind it are small, clients bring their
own persona prompt, and a tool result can contain text written by a stranger.
The behaviour layer is the smallest thing that keeps those three from turning
into a lie: one short text, added once, visible in the response.

It is not a jailbreak filter, not a content moderator, and not a second persona.
It is seven rules the gateway will not let a conversation silently drop.

## The text

`server/policy.md`, 647 characters, **162 estimated tokens** (this estimator:
ASCII/4 + non-ASCII/2). Kept short because a 1.5B model pays for every token in
attention and in a 4 096-token window, not because the rules are negotiable.

The first line is the dedupe key:

```
Gateway policy v1 — binding rules for every answer.
```

Change the rules and bump the version: the number is what tells the injector
whether the same policy is already present.

## How it is applied

| Situation | Result | Header |
| --- | --- | --- |
| no instruction message | one `system` message is inserted at index 0 | `applied;tokens=162` |
| a `system` (or `developer`) message exists | the policy is prepended to its text | `applied;tokens=162` |
| any instruction message already contains the marker | nothing is added | `present` |
| request sends `x-policy: off` | nothing is added for this call | `off` |
| `GATEWAY_POLICY=off` or no policy file | nothing is added | `disabled` |

Three properties follow, and each one is tested:

1. **Never twice.** Injection is idempotent: the second pass sees the marker in
   the text it just added and returns `present`. A client that ships its own
   copy of the policy also gets `present`, not a second copy.
2. **Never persisted.** `/v1/chat/completions` stores the client transcript, and
   only the outgoing copy is augmented. Replay from `messages: []` re-injects
   the policy once; it cannot grow turn by turn.
3. **Never hidden.** The header names the state and the token cost. A prompt edit
   the caller cannot see would be a watermark, and this project does not ship
   those.

## Measured (2026-10-26, llama.cpp 0.7.0, Qwen3-4B-Instruct Q4_K_M, ctx 4096)

```
POST /v1/messages/count_tokens, same body
  policy on  -> {"input_tokens":173}      # 162 text + 4 message overhead + 7 prompt
  policy off -> {"input_tokens":7}
  delta       166 tokens

POST /v1/chat/completions, "Say ready in three words."
  x-policy: applied;tokens=162, estimate 177, engine actual 169

same request with a system message containing "Gateway policy v1"
  x-policy: present, estimate 20          # nothing added

same request with x-policy: off
  x-policy: off, estimate 7

session replay (messages: [])
  x-policy: applied;tokens=162, estimate 179
  sqlite: 3 rows stored, 0 contain the marker
```

`node --test test/policy.test.ts` → 13/13 pass.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `GATEWAY_POLICY` | `auto` | `on` (file required, boot fails if unreadable), `off`, `auto` (on when the file exists). An unknown value fails at boot. |
| `GATEWAY_POLICY_FILE` | `server/policy.md` | Alternate file. Must contain the marker line. |

`GET /admin/system` publishes `enabled`, `mode`, `file`, `sha256`, `tokens` and
the reason, so the running text is identifiable without printing it.

## What this cannot do

- **It cannot make a small model obey.** A 1.5B model can still produce a wrong
  answer; the layer makes the expectation explicit and the deviation visible in
  the log, nothing more.
- **It cannot detect a different ethics prompt.** Dedupe is an exact marker
  match, not semantic similarity. A client with its own rules adds tokens; the
  gateway does not guess that two texts mean the same thing.
- **It does not filter output.** The sanitizer removes invisible carriers; this
  layer states rules. Neither one is a safety classifier.
- **It costs tokens on every request.** 162 per call, because it is deliberately
  not stored in session history. Storing it would save tokens and make replay
  fragile; this trade is the opposite of the usual one, on purpose.

## Why not store it once per session?

Because a stored system message becomes part of the transcript the client
resends, and then the gateway cannot tell its own text from the client's. The
marker check would say `present` forever and an edited policy would never take
effect. Re-injecting costs 162 tokens; a stale invisible prompt costs trust.
