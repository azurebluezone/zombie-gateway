#!/usr/bin/env node
/**
 * First-run setup, no dependencies.
 *
 * A fresh clone can run `npm start` without `npm install`: the runtime uses Node
 * builtins only, and this script creates the one file the server expects to
 * exist (.env) plus the data directory the database and log live in. It is
 * idempotent, so `prestart` can run it on every boot without changing anything
 * after the first time.
 *
 * Path rules mirror src/config.ts exactly: relative GATEWAY_DB / GATEWAY_LOG /
 * GATEWAY_DATA_DIR resolve against the package root (server/), never the
 * process working directory, so `node dist/index.js` and `npm start` agree.
 *
 * Usage:
 *   node scripts/setup.mjs            # create .env, prepare dirs, probe Ollama
 *   node scripts/setup.mjs --quiet    # same, silent, no probe (used by prestart)
 *   node scripts/setup.mjs --check    # exit 1 if something is missing
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = fileURLToPath(new URL("..", import.meta.url));
const quiet = process.argv.includes("--quiet");
const checkOnly = process.argv.includes("--check");
const say = (line) => {
  if (!quiet) console.log(line);
};
const fail = (line) => {
  console.error(line);
  process.exit(1);
};

const [major, minor] = process.versions.node.split(".").map(Number);
// 22.13 is the first 22.x where node:sqlite works without a flag; that is the
// real floor, so this check must not advertise a lower one.
if (major < 22 || (major === 22 && minor < 13)) {
  fail(`Node ${process.versions.node} is too old. This project needs >= 22.13 (node:sqlite).`);
}

const envPath = join(serverDir, ".env");
const examplePath = join(serverDir, ".env.example");
if (!existsSync(envPath)) {
  if (checkOnly) fail(`missing ${envPath}; run: npm run setup`);
  copyFileSync(examplePath, envPath);
  say(`created ${envPath} from .env.example`);
} else {
  say(`using ${envPath}`);
}

/** Only the keys setup needs. The server validates the rest at boot. */
function readEnv(file) {
  const values = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    values[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return values;
}

const env = readEnv(envPath);
const dataDir = env["GATEWAY_DATA_DIR"]
  ? resolve(serverDir, env["GATEWAY_DATA_DIR"])
  : join(serverDir, "data");
const dbPath = env["GATEWAY_DB"]
  ? resolve(serverDir, env["GATEWAY_DB"])
  : join(dataDir, "gateway.db");
const logPath = env["GATEWAY_LOG"]
  ? resolve(serverDir, env["GATEWAY_LOG"])
  : join(dataDir, "gateway.jsonl");
// The access log has its own variable, so it can point at a different
// directory. Create both parents; a missing directory is a boot failure, not a
// silent fallback.
const accessPath = env["GATEWAY_ACCESS_LOG"]
  ? resolve(serverDir, env["GATEWAY_ACCESS_LOG"])
  : join(dataDir, "access.jsonl");
for (const path of [dbPath, logPath, accessPath]) {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    if (checkOnly) fail(`missing directory ${dir}; run: npm run setup`);
    mkdirSync(dir, { recursive: true });
    say(`created ${dir}`);
  }
}

const host = env["GATEWAY_HOST"] || "127.0.0.1";
const port = (env["GATEWAY_PORT"] || "").trim();
const socket = (env["GATEWAY_SOCKET"] || "").trim();
if (!port && !socket) {
  fail(
    `${envPath} sets neither GATEWAY_PORT nor GATEWAY_SOCKET.\n` +
      "Add GATEWAY_PORT=5252 (see .env.example) or GATEWAY_SOCKET=/path/to/gateway.sock.",
  );
}
const url = port ? `http://${host}:${port}` : null;
say(`listening plan: ${url ? `${url}${socket ? ` and ${socket}` : ""}` : socket}`);

const providers = Object.keys(env).filter((key) => /^CP_.*_BASE_URL$/.test(key));
say(
  providers.length > 0
    ? `providers seeded from env: ${providers
        .map((key) => key.replace(/^CP_|_BASE_URL$/g, "").toLowerCase())
        .join(", ")}`
    : "no CP_*_BASE_URL in .env; add one provider or use the admin API",
);

// A probe is a convenience, not a gate: the gateway boots and answers /health
// even when the engine is down, which is the whole point of the health split.
if (!quiet && !checkOnly) {
  const base = (env["CP_OLLAMA_BASE_URL"] || "http://127.0.0.1:11434").replace(/\/+$/, "");
  const kind = (env["CP_OLLAMA_KIND"] || "ollama").toLowerCase();
  if (kind === "ollama") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const response = await fetch(`${base}/api/version`, { signal: controller.signal });
      const body = await response.json();
      say(`ollama: version ${body.version} at ${base}`);
    } catch {
      say(`ollama: not answering at ${base} (start it, or point CP_* at another engine)`);
    } finally {
      clearTimeout(timer);
    }
  }
  say("");
  say("next:");
  if (url) {
    say(`  npm start                        # ${url}`);
    say(`  curl -s ${url}/health`);
  } else {
    say("  npm start                        # Unix socket only");
    say(`  curl -s --unix-socket ${socket} http://localhost/health`);
  }
  say("  npm run live                     # real engine, end to end");
}
