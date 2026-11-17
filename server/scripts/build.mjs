#!/usr/bin/env node
/**
 * Emit the runtime into dist/.
 *
 * Why a build step at all, when Node runs the .ts files directly? Because a
 * deployment sometimes treats `dist/` as the unit: a read-only image, a
 * container layer, a packaging script, or a supervisor that refuses to start
 * anything containing a TypeScript extension. `node dist/index.js` is then a
 * plain ESM program with no loader flags and no tsconfig in sight.
 *
 * The layout mirrors src/, which is deliberate: identity.json and policy.md are
 * found via `new URL("../identity.json", import.meta.url)` and
 * `new URL("../../policy.md", import.meta.url)`. From src/identity.ts and
 * dist/identity.js those two expressions resolve to the same server/ directory,
 * so the built tree needs no copied assets.
 *
 * Usage:
 *   node scripts/build.mjs           # clean dist/ and emit
 *   node scripts/build.mjs --keep    # emit over an existing dist/
 *
 * TypeScript is a devDependency, so this needs `npm install` once. The runtime
 * itself still has zero dependencies; only the compiler is borrowed.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = fileURLToPath(new URL("..", import.meta.url));
const distDir = join(serverDir, "dist");
const tsc = join(serverDir, "node_modules", "typescript", "bin", "tsc");
const keep = process.argv.includes("--keep");

if (!existsSync(tsc)) {
  console.error(
    "build: typescript is not installed.\n" +
      "  cd server && npm install --no-audit --no-fund\n" +
      "The gateway itself needs no dependencies; only the compiler does.",
  );
  process.exit(1);
}

if (existsSync(distDir) && !keep) {
  rmSync(distDir, { recursive: true, force: true });
}

const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], {
  cwd: serverDir,
  stdio: "inherit",
});
if (result.error) {
  console.error(`build: failed to start tsc: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  console.error(`build: tsc exited with ${result.status ?? "no status"}`);
  process.exit(result.status ?? 1);
}

/** Count emitted files so a silent "0 files" build cannot look like success. */
function countFiles(dir) {
  let files = 0;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    files += statSync(path).isDirectory() ? countFiles(path) : 1;
  }
  return files;
}

const emitted = existsSync(distDir) ? countFiles(distDir) : 0;
if (emitted === 0) {
  console.error(`build: tsc reported success but ${distDir} is empty`);
  process.exit(1);
}

console.log(`build: ${emitted} files in ${distDir}`);
console.log("build: run it with");
console.log("  node --env-file-if-exists=.env dist/index.js");
console.log("  # or: npm run start:dist");
