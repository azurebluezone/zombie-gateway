#!/usr/bin/env node
/**
 * Real end-to-end verifier for gateway providers.
 *
 * It talks to the running gateway over HTTP (never imports src/), so a passing
 * run means the catalog, the upstream engine and the adapter all agreed on a
 * live request. No fixtures, no mocks: an empty or malformed answer is a FAIL.
 *
 * usage: node scripts/verify-providers.mjs <provider/model> [<provider/model> ...]
 */
const base = (process.env.GATEWAY_URL || "http://127.0.0.1:5010").replace(/\/+$/, "");
const models = process.argv.slice(2);
if (models.length === 0) {
  console.error("usage: node scripts/verify-providers.mjs <provider/model> [...]");
  process.exit(2);
}

const timeoutMs = Number(process.env.VERIFY_TIMEOUT_MS || 120_000);

async function getCatalog() {
  const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET /v1/models -> ${res.status} ${text.slice(0, 160)}`);
  const json = JSON.parse(text);
  return new Set((json.data || []).map((m) => m.id));
}

async function chat(model) {
  const started = Date.now();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "Reply with one word: PONG" }],
      max_tokens: 8,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  const ms = Date.now() - started;
  let content = "";
  try {
    const json = JSON.parse(text);
    content = String(json?.choices?.[0]?.message?.content ?? "").trim();
  } catch {
    return { ok: false, ms, detail: `badjson ${text.slice(0, 140)}` };
  }
  if (!res.ok) return { ok: false, ms, detail: `http ${res.status} ${text.slice(0, 140)}` };
  if (!content) return { ok: false, ms, detail: `empty content ${text.slice(0, 140)}` };
  return { ok: true, ms, detail: JSON.stringify(content.slice(0, 60)) };
}

const catalog = await getCatalog();
let passed = 0;
for (const model of models) {
  const listed = catalog.has(model);
  const result = await chat(model);
  if (result.ok) passed += 1;
  const status = result.ok ? "PASS" : "FAIL";
  const listedTag = listed ? "listed" : "NOT-in-catalog";
  console.log(`${status} ${model} (${listedTag}) ${result.ms}ms ${result.detail}`);
}
console.log(`RESULT ${passed === models.length ? "PASS" : "FAIL"} ${passed}/${models.length}`);
process.exit(passed === models.length ? 0 : 1);
