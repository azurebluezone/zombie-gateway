# Release check — automated gate

What this file is: the evidence behind the "tested" column of the status tables.
Every number here was produced by a command run on this machine on 2026-10-27;
an item without a command and an output is `UNVERIFIED`.

## 1. Commands

```bash
cd server
npm run typecheck        # tsc --noEmit
npm test                 # node --test test/*.test.ts
```

Measured 2026-10-27 (Node 24.19.0, Ubuntu, 4 cores):

| Check | Result |
| --- | --- |
| `tsc --noEmit` | exit 0 |
| `npm test` | `tests 49 ` · `pass 49 ` · `fail 0` |

Suite split: sanitizer 24, behaviour layer 13, integration 12.
The script is `node --test test/*.test.ts`: naming the files keeps the harness
(`test/fixture.ts`) out of the run, where it would otherwise be reported as one
more passing "test".

```
ℹ tests 49
ℹ pass 49
ℹ fail 0
```

## 2. Integration suite

Files: `server/test/fixture.ts` (an upstream double plus a spawned gateway),
`server/test/gateway.test.ts` (the cases). The gateway is the real entry point
(`node src/index.ts`) with a temporary database and log per case; no test-only
code path exists inside `src/`.

| Case | Asserts | What it would catch |
| --- | --- | --- |
| health | 200, `status:"ok"`, identity headers present | boot regression, missing identity |
| catalogue | `provider/model` id, engine `context_length`, `completion`+declared caps | model-id drift, lost capability |
| non-stream chat | completion body, `usage`, `x-context-limit`, `x-policy` shape | broken JSON path, missing ledger headers |
| stream chat | `text/event-stream`, exactly one `data: [DONE]`, frames forwarded, usage frame | duplicated terminator, swallowed chunks |
| upstream 500 | status 500, code `internal_error`, message `fixture exploded` | envelope mapping, message loss |
| socket inactivity | 504 `provider_timeout` (`CP_FIX_TIMEOUT_MS=1000`) | hung upstream never timing out |
| unreachable provider | 502 `provider_unreachable` | connect errors leaking as 500 |
| client abort | gateway tears down the upstream stream within 4 s | upstream work continuing after the client left |
| body limit | 413 with `exceeds 512 bytes` | silent truncation |
| prompt shutdown | SIGTERM with an idle keep-alive socket returns in < 1500 ms | shutdown waiting on keep-alive |
| admin auth | 401 anonymous, 200 with `x-admin-token` | admin surface open by accident |
| admin mutation | create 201 → disable 200 → list shows disabled → purge 200 → gone | registry/DB divergence |

Measured per-case wall clock (integration file, one run):

```
✔ health reports identity and counts (405ms)
✔ catalogue qualifies the model id ... (441ms)
✔ non-stream chat ... (454ms)
✔ stream chat ... (345ms)
✔ an upstream 500 ... (347ms)
✔ socket inactivity is a 504 provider_timeout (1348ms)
✔ an unreachable provider is a 502 provider_unreachable (350ms)
✔ a client abort tears down the upstream stream (349ms)
✔ a body over the limit is a 413 ... (333ms)
✔ shutdown is prompt even with an idle keep-alive connection (333ms)
✔ admin auth is one switch ... (339ms)
✔ admin can create, toggle and purge ... (364ms)
```

Each case spawns a gateway (process start ≈ 330 ms), so that number is the
floor, not the request latency. The 1348 ms timeout case is the fixture's
1500 ms stall cut by a 1000 ms socket timeout: the floor is the configured
timeout, not the gateway's speed.

## 3. Failure injection

The fixture chooses behaviour from a marker inside the user message, so no
gateway code is test-aware:

| Marker | Upstream does |
| --- | --- |
| `MODE:500` | returns HTTP 500 with `{"error":{"message":"fixture exploded"}}` |
| `MODE:SLOW` | stalls 1500 ms before answering |
| `MODE:ABORT` | streams one chunk, then reports when the gateway closes the socket |
| `MODE:PREMATURE` | streams one chunk, then destroys the socket mid-frame |

`MODE:PREMATURE` is implemented but has no assertion yet: the stream is cut
before a terminator and the client sees an incomplete SSE stream. That is a
known gap, tracked here rather than described as covered.

## 4. Shutdown defect found by the suite

First run of the client-abort case took **3442 ms** while the gateway log showed
the request dying at `durationMs: 20`. The delay was not request cleanup:

```
gateway.stop() took 3003 ms
...
{"level":"warn","event":"gateway.force_close","connections":1,
 "peers":[{"remote":"127.0.0.1:54572","destroyed":false,"readable":true,"writable":true}]}
```

Cause: after the client aborted, its HTTP pool opened **one more TCP connection
and sent nothing on it**. That silent socket is neither "in flight" nor
recognised as idle by `server.closeIdleConnections()`, so `server.close()`
waited for the force-close timer.

Fix (`server/src/index.ts`): two sets are tracked per connection — `openSockets`
and `busySockets` (incremented on `request`, released on `finish`/`close`).
Shutdown destroys every open socket that never entered a request before falling
back to `closeIdleConnections()` and the 3 s grace timer. In-flight streams keep
their grace period.

A second candidate — destroying the response socket from the `close` handler —
was tried and discarded. The trace showed the socket was already
`destroyed: true` when the handler ran, so the extra call would have been a
no-op presented as a fix.

After the fix:

```
gateway.stop() took 32 ms
✔ a client abort tears down the upstream stream (349ms)
```

## 5. Defects the suite caught before release

| Defect | Fix |
| --- | --- |
| `kind=openai` catalogue omitted `completion` | driver declares `completion` plus `caps`; `server/src/providers/openai.ts` |
| `CP_*_TIMEOUT_MS=400` silently became 300 s | invalid or < 1000 now fails boot; `server/src/config.ts` |
| SIGTERM hung on idle keep-alive sockets | `closeIdleConnections()` + force-close (§4) |
| client abort left a silent pooled socket | busy/open socket tracking (§4) |

## 6. What this gate does not prove

- Answer quality of any engine. Ollama and llama.cpp evidence lives in
  [`STEPS.md`](STEPS.md) and [`LLAMACPP-LIVE.md`](LLAMACPP-LIVE.md).
- TLS termination — not implemented.
- The 30-minute soak (RSS slope, p95 latency, chunk gaps) from S7 — `NOT_TESTED`.
- `MODE:PREMATURE` mid-stream socket death — implemented, not asserted.
- Admin WebSocket behaviour under the new shutdown path — covered by the earlier
  manual probes in [`ADMIN-API.md`](ADMIN-API.md), not by `npm test`.
