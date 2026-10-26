/**
 * Behaviour layer tests.
 *
 * The properties that matter are not "does it contain nice words" but:
 * injection happens once, the caller's array is not mutated, disabling is
 * silent-free (the state is reported), and the token count is a real number.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  POLICY_MARKER,
  injectPolicy,
  loadPolicy,
  policyHeader,
  type LoadedPolicy,
} from "../src/core/policy.ts";
import type { ChatMessage } from "../src/core/session.ts";

function fakePolicy(text = `${POLICY_MARKER} — be honest.`): LoadedPolicy {
  return {
    enabled: true,
    text,
    sha256: "0".repeat(64),
    tokens: 12,
    source: "test",
    reason: "loaded",
  };
}

const OFF = loadPolicy("off");

test("off mode loads no text", () => {
  assert.equal(OFF.enabled, false);
  assert.equal(OFF.text, "");
  assert.equal(OFF.tokens, 0);
});

test("the bundled policy file loads, carries the marker and has a hash", () => {
  const policy = loadPolicy("on");
  assert.equal(policy.enabled, true);
  assert.ok(policy.text.includes(POLICY_MARKER));
  assert.match(policy.sha256, /^[0-9a-f]{64}$/);
  assert.ok(policy.tokens > 50, `expected a real token count, got ${policy.tokens}`);
});

test("on mode fails loudly when the file is missing", () => {
  assert.throws(() => loadPolicy("on", "/tmp/does-not-exist-policy.md"), /unreadable/);
});

test("auto mode stays off, with a reason, when the file is missing", () => {
  const policy = loadPolicy("auto", "/tmp/does-not-exist-policy.md");
  assert.equal(policy.enabled, false);
  assert.match(policy.reason, /missing/);
});

test("a policy file without the marker is rejected: dedupe would not work", () => {
  const dir = mkdtempSync(join(tmpdir(), "policy-"));
  const file = join(dir, "policy.md");
  writeFileSync(file, "Be nice to everyone.\n", "utf8");
  assert.throws(() => loadPolicy("on", file), /marker/);
});

test("injects one system message when none exists, without mutating the input", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
  const result = injectPolicy(messages, fakePolicy());

  assert.equal(result.state, "applied");
  assert.equal(result.tokens, 12);
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0]?.role, "system");
  assert.equal(messages.length, 1, "caller transcript must not change");
});

test("merges into the first system message instead of adding a second", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "You are a terse assistant." },
    { role: "user", content: "hi" },
  ];
  const result = injectPolicy(messages, fakePolicy());

  assert.equal(result.state, "applied");
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0]?.content, `${fakePolicy().text}\n\nYou are a terse assistant.`);
  assert.equal(messages[0]?.content, "You are a terse assistant.");
});

test("a system message already carrying the marker is left alone", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: `${POLICY_MARKER} — already here.` },
    { role: "user", content: "hi" },
  ];
  const result = injectPolicy(messages, fakePolicy());

  assert.equal(result.state, "present");
  assert.equal(result.tokens, 0);
  assert.equal(result.messages, messages);
});

test("array content is extended with a text part, not stringified", () => {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: [{ type: "text", text: "Existing instruction." }],
    },
  ];
  const result = injectPolicy(messages, fakePolicy());
  const content = result.messages[0]?.content;

  assert.equal(result.state, "applied");
  assert.ok(Array.isArray(content));
  assert.equal((content as Array<Record<string, unknown>>)[0]?.["type"], "text");
  assert.equal(
    (content as Array<Record<string, unknown>>)[0]?.["text"],
    `${fakePolicy().text}\n\nExisting instruction.`,
  );
});

test("the x-policy: off header skips injection for one call", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
  const result = injectPolicy(messages, fakePolicy(), "OFF");

  assert.equal(result.state, "off");
  assert.equal(result.messages, messages);
});

test("a disabled gateway reports disabled even when the client sends x-policy: on", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "hi" }];
  const result = injectPolicy(messages, OFF, "on");

  assert.equal(result.state, "disabled");
  assert.equal(result.messages, messages);
});

test("injecting twice is a no-op: the second pass sees the marker", () => {
  const first = injectPolicy([{ role: "user", content: "hi" }], fakePolicy());
  const second = injectPolicy(first.messages, fakePolicy());

  assert.equal(second.state, "present");
  assert.equal(second.messages.length, first.messages.length);
});

test("the header names the state and the added tokens, never the text", () => {
  const applied = injectPolicy([{ role: "user", content: "hi" }], fakePolicy());
  assert.equal(policyHeader(applied), "applied;tokens=12");
  assert.equal(policyHeader({ messages: [], state: "present", tokens: 0 }), "present");
  assert.equal(policyHeader({ messages: [], state: "off", tokens: 0 }), "off");
  assert.equal(policyHeader({ messages: [], state: "disabled", tokens: 0 }), "disabled");
});
