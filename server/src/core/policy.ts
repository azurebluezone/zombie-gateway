/**
 * Behaviour layer (the "ethics" prompt).
 *
 * A gateway sits between a client that already has its own persona and a model
 * that is often small. That shapes five rules:
 *
 *  - **Short.** A 1.5B model pays for every token in attention and in context,
 *    so this is a few lines, not a constitution. `server/policy.md` is capped by
 *    review, not by code.
 *  - **Once.** A marker line makes injection idempotent. If any system message
 *    already carries the marker (the client, a plugin, or a previous layer), the
 *    gateway adds nothing, so ethics cannot be stacked twice.
 *  - **Not persisted.** The caller stores the client transcript, never the
 *    augmented copy, so replay cannot multiply the text.
 *  - **Visible.** `x-policy` reports applied / present / off / disabled and the
 *    number of tokens actually added. A hidden prompt edit would be a watermark,
 *    and this project does not ship those.
 *  - **Data stays data.** Rule 3 exists because the gateway forwards tool output,
 *    logs and web text; none of it may become an instruction.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ChatMessage } from "./session.ts";
import { estimateTokens } from "./tokens.ts";

/** Stable identity of the injected text; also the dedupe key. */
export const POLICY_MARKER = "Gateway policy v1";

export type PolicyMode = "on" | "off" | "auto";

export interface LoadedPolicy {
  enabled: boolean;
  text: string;
  sha256: string;
  /** Character-based estimate, the same estimator the context ledger uses. */
  tokens: number;
  source: string;
  reason: string;
}

export type PolicyState = "applied" | "present" | "off" | "disabled";

export interface PolicyInjection {
  /** A new array; the caller's transcript is never mutated. */
  messages: ChatMessage[];
  state: PolicyState;
  /** Tokens this injection added; 0 unless state is "applied". */
  tokens: number;
}

const DEFAULT_FILE = fileURLToPath(new URL("../../policy.md", import.meta.url));

function disabled(source: string, reason: string): LoadedPolicy {
  return { enabled: false, text: "", sha256: "", tokens: 0, source, reason };
}

/**
 * Reads the policy once, at boot.
 *
 * `auto` is the default: enable when the file exists, otherwise stay off and say
 * why in the log. `on` is strict on purpose — an operator who asked for the
 * behaviour layer must not silently run without it.
 */
export function loadPolicy(mode: PolicyMode, explicitFile?: string): LoadedPolicy {
  const source = explicitFile && explicitFile.length > 0 ? explicitFile : DEFAULT_FILE;
  if (mode === "off") return disabled(source, "GATEWAY_POLICY=off");

  let raw: string;
  try {
    raw = readFileSync(source, "utf8");
  } catch {
    if (mode === "on") {
      throw new Error(`GATEWAY_POLICY=on but the policy file is unreadable: ${source}`);
    }
    return disabled(source, "file missing");
  }

  const text = raw.replace(/\r\n/g, "\n").trim();
  if (text.length === 0) {
    if (mode === "on") throw new Error(`GATEWAY_POLICY=on but the policy file is empty: ${source}`);
    return disabled(source, "file empty");
  }
  if (!text.includes(POLICY_MARKER)) {
    // The marker is the dedupe key. Without it, injection could double the text
    // on every replay, which is exactly the failure this layer must avoid.
    throw new Error(`Policy file must contain the marker "${POLICY_MARKER}": ${source}`);
  }

  return {
    enabled: true,
    text,
    sha256: createHash("sha256").update(text, "utf8").digest("hex"),
    tokens: estimateTokens(text),
    source,
    reason: "loaded",
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const record = part as Record<string, unknown>;
    if (record["type"] === "text" && typeof record["text"] === "string") {
      parts.push(record["text"]);
    }
  }
  return parts.join("\n");
}

function isSystemish(role: string): boolean {
  // `developer` is the newer OpenAI spelling of `system`; both are instructions.
  return role === "system" || role === "developer";
}

/**
 * Prepends the policy to the first instruction message, or inserts one.
 *
 * `override` is the `x-policy` request header: `off` opts out for one call.
 * Anything else leaves the decision to configuration, so a client cannot turn
 * the policy on for a gateway that has it disabled.
 */
export function injectPolicy(
  messages: ChatMessage[],
  policy: LoadedPolicy,
  override: string | null = null,
): PolicyInjection {
  if (override !== null && override.trim().toLowerCase() === "off") {
    return { messages, state: "off", tokens: 0 };
  }
  if (!policy.enabled) return { messages, state: "disabled", tokens: 0 };
  if (messages.length === 0) return { messages, state: "disabled", tokens: 0 };

  for (const message of messages) {
    if (isSystemish(message.role) && textOf(message.content).includes(POLICY_MARKER)) {
      return { messages, state: "present", tokens: 0 };
    }
  }

  const index = messages.findIndex((message) => isSystemish(message.role));
  if (index === -1) {
    return {
      messages: [{ role: "system", content: policy.text }, ...messages],
      state: "applied",
      tokens: policy.tokens,
    };
  }

  const target = messages[index];
  if (!target) return { messages, state: "disabled", tokens: 0 };

  let content: unknown;
  if (Array.isArray(target.content)) {
    const parts = target.content as unknown[];
    const head = parts[0];
    const headRecord =
      typeof head === "object" && head !== null ? (head as Record<string, unknown>) : null;
    if (headRecord && headRecord["type"] === "text" && typeof headRecord["text"] === "string") {
      content = [{ ...headRecord, text: `${policy.text}\n\n${headRecord["text"]}` }, ...parts.slice(1)];
    } else {
      content = [{ type: "text", text: policy.text }, ...parts];
    }
  } else if (typeof target.content === "string" && target.content.length > 0) {
    content = `${policy.text}\n\n${target.content}`;
  } else {
    content = policy.text;
  }

  const next = messages.slice();
  next[index] = { ...target, content };
  return { messages: next, state: "applied", tokens: policy.tokens };
}

/** One short header value; no prompt text ever leaves this module. */
export function policyHeader(injection: PolicyInjection): string {
  return injection.state === "applied"
    ? `applied;tokens=${injection.tokens}`
    : injection.state;
}
