/**
 * Sanitizer unit tests.
 *
 * Run: node --test test/sanitize.test.ts
 *
 * Every case below is a claim the gateway makes in a header or a log line, so
 * the test names are the contract: orthography survives, carriers do not, and
 * reporting never edits the input unless the mode is "strip".
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyReport,
  isSuspicious,
  mergeReports,
  reportHeader,
  sanitizeJson,
  sanitizeText,
  scanText,
} from "../src/core/sanitize.ts";

const ZWSP = "\u200B";
const ZWNJ = "\u200C";
const ZWJ = "\u200D";

test("Bengali ZWNJ between a virama and a consonant survives (orthography)", () => {
  // ক + ্ + ZWNJ + ষ: the ZWNJ is what prevents the conjunct here.
  const input = `ক্${ZWNJ}ষ`;
  const { text, report } = sanitizeText(input, "strip");
  assert.equal(text, input);
  assert.equal(report.detected, 1);
  assert.equal(report.removed, 0);
});

test("emoji ZWJ sequence survives", () => {
  const family = `\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}`;
  const { text, report } = sanitizeText(`family ${family}`, "strip");
  assert.equal(text, `family ${family}`);
  assert.equal(report.removed, 0);
});

test("Persian ZWNJ between letters survives", () => {
  const input = `می${ZWNJ}خواهم`;
  assert.equal(sanitizeText(input, "strip").text, input);
});

test("zero-width space is always removed, even between letters", () => {
  const { text, report } = sanitizeText(`hello${ZWSP}world`, "strip");
  assert.equal(text, "helloworld");
  assert.equal(report.kinds["zero-width"], 1);
});

test("a ZWJ run of three is not orthography and is removed", () => {
  const { text, report } = sanitizeText(`a${ZWJ}${ZWJ}${ZWJ}b`, "strip");
  assert.equal(text, "ab");
  assert.equal(report.runs, 1);
});

test("Unicode tag block is removed and counted (hidden-instruction carrier)", () => {
  const payload = `hi\u{E0041}\u{E0042}\u{E0043}`;
  const { text, report } = sanitizeText(payload, "strip");
  assert.equal(text, "hi");
  assert.equal(report.tags, 3);
  assert.equal(report.removed, 3);
});

test("bidi override is removed and counted", () => {
  const { text, report } = sanitizeText(`abc\u202Edef`, "strip");
  assert.equal(text, "abcdef");
  assert.equal(report.bidi, 1);
});

test("soft hyphen and BOM are removed", () => {
  const { text } = sanitizeText(`so\u00ADft\uFEFF`, "strip");
  assert.equal(text, "soft");
});

test("control bytes are removed but tab, LF and CR are kept", () => {
  const { text, report } = sanitizeText("a\tb\nc\rd\u0007", "strip");
  assert.equal(text, "a\tb\nc\rd");
  assert.equal(report.kinds["control-byte"], 1);
});

test("eight consecutive invisibles set hiddenPayload", () => {
  const report = scanText(`x${ZWSP.repeat(8)}y`);
  assert.equal(report.hiddenPayload, true);
  assert.equal(isSuspicious(report), true);
});

test("trailing double-space mark is detected on an ASCII document", () => {
  const lines = Array.from({ length: 12 }, (_, index) => `line ${index}  `).join("\n");
  const report = scanText(lines);
  assert.equal(report.trailingMark, true);
  assert.equal(reportHeader(report), "trailing-mark");
});

test("occasional markdown hard breaks are not a mark", () => {
  const lines = ["a  ", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].join("\n");
  assert.equal(scanText(lines).trailingMark, false);
});

test("report mode counts without editing a single byte", () => {
  const input = `x${ZWSP}y\u{E0041}`;
  const { text, report } = sanitizeText(input, "report");
  assert.equal(text, input);
  assert.equal(report.detected, 2);
  assert.equal(report.removed, 0);
});

test("off mode does not even scan", () => {
  const input = `x${ZWSP}y\u{E0041}`;
  const { text, report } = sanitizeText(input, "off");
  assert.equal(text, input);
  assert.equal(report.detected, 0);
  assert.equal(reportHeader(report), "off");
});

test("a lone ZWNJ inside a Latin word is a carrier and is removed", () => {
  const { text, report } = sanitizeText(`a${ZWNJ}b`, "strip");
  assert.equal(text, "ab");
  assert.equal(report.removed, 1);
});

test("a lone ZWNJ inside a Bengali word survives", () => {
  const input = `ক্${ZWNJ}ষ`;
  assert.equal(sanitizeText(input, "strip").text, input);
});

test("JSON nesting beyond 64 levels is rejected, not walked", () => {
  let deep: unknown = "x";
  for (let index = 0; index < 70; index += 1) deep = [deep];
  assert.throws(
    () => sanitizeJson({ messages: deep }, "strip"),
    (error: unknown) =>
      error instanceof Error && (error as { status?: number }).status === 400,
  );
});

test("JSON nesting at 60 levels still passes", () => {
  let deep: unknown = "x";
  for (let index = 0; index < 60; index += 1) deep = [deep];
  assert.doesNotThrow(() => sanitizeJson({ messages: deep }, "strip"));
});

test("sanitising twice changes nothing (idempotent)", () => {
  const input = `a${ZWSP}b${ZWJ}${ZWJ}c\u{E0041}দ\u202E`;
  const once = sanitizeText(input, "strip").text;
  const twice = sanitizeText(once, "strip").text;
  assert.equal(twice, once);
});

test("lone ZWJ at the string edge has no orthographic reading and is removed", () => {
  assert.equal(sanitizeText(`${ZWJ}abc`, "strip").text, "abc");
  assert.equal(sanitizeText(`abc${ZWJ}`, "strip").text, "abc");
});

test("JSON walk cleans nested strings and reports once", () => {
  const body = {
    model: "ollama/qwen2.5:1.5b",
    messages: [{ role: "user", content: `hi${ZWSP}there` }],
    input: [`doc${ZWSP}one`, `doc\u{E0041}two`],
  };
  const { value, report } = sanitizeJson(body, "strip");
  assert.equal((value.messages[0] as { content: string }).content, "hithere");
  assert.deepEqual(value.input, ["docone", "doctwo"]);
  assert.equal(report.detected, 3);
  assert.equal(report.tags, 1);
  assert.equal((body.messages[0] as { content: string }).content, `hi${ZWSP}there`);
});

test("a key collision keeps both keys and flags it", () => {
  const body = { ["a" + ZWSP]: 1, a: 2 };
  const { value, report } = sanitizeJson(body, "strip");
  assert.equal(report.keyCollision, true);
  assert.equal(Object.keys(value).length, 2);
});

test("empty reports never share a mutable kinds object", () => {
  const left = emptyReport("strip");
  const right = emptyReport("strip");
  mergeReports(left, scanText(`${ZWSP}`));
  assert.equal(right.detected, 0);
  assert.deepEqual(right.kinds, {});
});

test("header carries counts and flags, never content", () => {
  const report = scanText(`a${ZWSP}${ZWSP}b\u{E0041}c\u202Ed`);
  const header = reportHeader(report);
  assert.match(header, /zero-width:2/);
  assert.match(header, /unicode-tag:1/);
  assert.match(header, /bidi-control:1/);
  assert.equal(header.includes(ZWSP), false);
  assert.equal(header.length < 80, true);
});
