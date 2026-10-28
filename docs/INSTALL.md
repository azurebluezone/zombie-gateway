# Install and first run

The short version, from a fresh clone:

```bash
git clone git@github.com:azurebluezone/zombie-gateway.git
cd zombie-gateway/server
npm start
```

There is no `npm install` in that list on purpose: the gateway has **zero runtime
dependencies**, so `node` and `npm` are enough. `npm start` runs
`scripts/setup.mjs` first, which creates `.env` from `.env.example` once, creates
`data/`, and prints the URL it is about to use. The server then creates the
SQLite database on its own (`server/src/core/db.ts` calls `mkdirSync(recursive)`).

```bash
curl -s http://127.0.0.1:5252/health
curl -s http://127.0.0.1:5252/v1/models
```

`npm install --no-audit --no-fund` is only needed for `npm run typecheck`
(`typescript` and `@types/node`).

## What the first run creates

| Path | Who creates it | Why |
| --- | --- | --- |
| `server/.env` | `scripts/setup.mjs` | copy of `.env.example`; edit the `CP_*` block |
| `server/data/` | `scripts/setup.mjs` | default `GATEWAY_DB` directory |
| `server/logs/` | `scripts/setup.mjs` | default `GATEWAY_LOG` / `GATEWAY_ACCESS_LOG` directory |
| `server/data/gateway.db` | the server, at boot | SQLite WAL database |
| `server/logs/gateway.jsonl` | the server, at boot | lifecycle log, one JSON object per line |
| `server/logs/access.jsonl` | the server, per request | one line per HTTP request, success or failure |

Relative paths in `.env` are resolved against the **process working directory**,
which is `server/` when you use `npm start`. Starting `node src/index.ts` from a
different directory moves `./data` with it; use an absolute `GATEWAY_DB` if that
matters.

## Requirements

| Item | Value |
| --- | --- |
| Node | `>= 22.13` (the code needs `node:sqlite` without a flag and `--env-file-if-exists`); tested on 24.19.0 |
| npm | any version that ships with that Node; only used to run scripts |
| Engine | Ollama, `llama-server`, or any OpenAI-compatible `/v1` endpoint |
| Ports | 5252 by default; no root, no `sudo`, because it binds `127.0.0.1` |

`npm start` refuses to guess: if `.env` names a provider whose engine is down, the
gateway still boots and answers `/health` — that split is deliberate, so a script
can tell "gateway down" from "model loading".

## Choosing an engine

Everything is an environment variable; the database is only a cache of what the
environment seeded. The smallest useful `.env`:

```bash
# Ollama on the default port (already in .env.example)
GATEWAY_PORT=5252
CP_OLLAMA_KIND=ollama
CP_OLLAMA_BASE_URL=http://127.0.0.1:11434
```

```bash
# llama.cpp server
CP_LLAMACPP_KIND=llamacpp
CP_LLAMACPP_BASE_URL=http://127.0.0.1:8080
CP_LLAMACPP_CAPS=tools

# any OpenAI-compatible cloud API
CP_CUSTOM_KIND=openai
CP_CUSTOM_BASE_URL=https://api.example.com/v1
CP_CUSTOM_API_KEY=sk-...
CP_CUSTOM_MODELS=gpt-4o-mini      # only for engines that do not list /models
```

Models are addressed as `<provider>/<model>`, e.g. `ollama/qwen2.5:1.5b` or
`custom/gpt-4o-mini`. `CP_<ID>_MODELS` **adds** ids the engine does not list; it
never hides ids the engine does list. Models themselves are loaded by the engine
on first use, so `CP_*_MODELS` is what makes an env-only deployment work when
`/v1/models` is missing or empty.

## Windows vs Linux

| Topic | Linux / macOS | Windows |
| --- | --- | --- |
| Start | `npm start` in a shell | `npm start` in PowerShell or cmd |
| Default listener | `127.0.0.1:5252` TCP | same |
| Unix socket (`GATEWAY_SOCKET`) | filesystem path, e.g. `/run/user/1000/gateway.sock` | named pipe only, e.g. `\\.\pipe\gateway`; a filesystem path fails at boot with a clear error |
| Socket permissions | `GATEWAY_SOCKET_MODE` (octal, default `660`) | ignored; pipe ACLs come from the OS |
| Stop | `SIGTERM` / `SIGINT` — graceful, closes panels with `1001` | Ctrl+C sends `SIGINT` (graceful); `taskkill /F` is a hard kill (no graceful shutdown) |
| Paths | any path, spaces are fine | backslashes or forward slashes both work; `GATEWAY_DB=C:\gateway\data.db` is valid |
| SQLite file locking | fine | fine; keep the DB on a local disk, not a network share |

Measured here: the repo lives at `/home/sahon/Compatible Providers` (a space in
the path) and every command in these docs runs unquoted-safe through `npm`.

## Folder and path constraints

- `data/` must be writable by the user running the gateway; SQLite creates
  `gateway.db`, `-wal` and `-shm` next to it.
- A Unix socket path is limited by `sun_path`: **~107 bytes on Linux**, ~104 on
  macOS. Long home directories plus a long file name can exceed it; use
  `/run/user/<uid>/` or `/tmp/`.
- The socket's directory is created if missing. An existing socket is unlinked
  only after a 300 ms connect probe proves nobody is listening; a live socket
  stops the boot with `GATEWAY_SOCKET ... is already in use`.
- The socket file is removed on graceful shutdown, so a crash is the only case
  that leaves a stale file behind — and the next boot logs `gateway.socket_stale`
  when it clears it.

## Common first-run failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| `EADDRINUSE` | another process on 5252 | `GATEWAY_PORT=5253 npm start` |
| `GATEWAY_ADMIN_AUTH is enabled but GATEWAY_ADMIN_TOKEN is empty` | `GATEWAY_ADMIN_AUTH=1` with no token | set a token, or `GATEWAY_ADMIN_AUTH=0` |
| `GATEWAY_SOCKET ... already in use` | a second gateway on the same socket | stop the first, or use another path |
| `/health` is fine, `/v1/models` is empty | engine down at boot, or no provider configured | `curl -X POST :5252/admin/sync`, check `GET /v1/providers` |
| `provider_timeout` on the first call | model is loading (cold start) | wait; the timeout is `CP_*_TIMEOUT_MS`, minimum 1000 ms |
