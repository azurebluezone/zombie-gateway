/**
 * OpenAI chat-completions adapter.
 *
 * Translation only: upstream payload in, OpenAI-shaped payload out. Nothing
 * here knows about transports, SQLite or sessions, which keeps the wire format
 * testable in isolation and lets a second adapter (Anthropic /v1/messages) reuse
 * the same core.
 */

import { randomUUID } from "node:crypto";
import { fullModelId, type ResolvedModel } from "../core/catalog.ts";
import { estimateTokens } from "../core/tokens.ts";
import type { ChatMessage } from "../core/session.ts";

export type Json = Record<string, unknown>;

/** Token estimation lives in core/tokens.ts; re-exported for adapter callers. */
export { estimateTokens } from "../core/tokens.ts";

export function messageText(message: ChatMessage): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) =>
        typeof part === "object" && part !== null && "text" in part
          ? String((part as Json)["text"] ?? "")
          : "",
      )
      .join("");
  }
  return "";
}

export function normaliseArguments(toolCalls: unknown): void {
  if (!Array.isArray(toolCalls)) return;
  for (const call of toolCalls) {
    if (typeof call !== "object" || call === null) continue;
    const fn = (call as Json)["function"];
    if (typeof fn !== "object" || fn === null) continue;
    const args = (fn as Json)["arguments"];
    if (typeof args === "object" && args !== null) {
      (fn as Json)["arguments"] = JSON.stringify(args);
    }
  }
}

function normaliseMessage(message: Json): void {
  if (message["content"] === undefined) message["content"] = "";
  normaliseArguments(message["tool_calls"]);
}

export function normaliseCompletion(
  payload: Json,
  resolved: ResolvedModel,
  promptText: string,
): Json {
  const out: Json = { ...payload };
  out["id"] = typeof out["id"] === "string" ? out["id"] : `chatcmpl-${randomUUID()}`;
  out["object"] = "chat.completion";
  out["created"] = typeof out["created"] === "number" ? out["created"] : Math.floor(Date.now() / 1000);
  out["model"] = fullModelId(resolved.providerId, resolved.modelId);

  const choices = Array.isArray(out["choices"]) ? (out["choices"] as Json[]) : [];
  let completionText = "";

  for (const choice of choices) {
    const message = choice["message"];
    if (typeof message === "object" && message !== null) {
      normaliseMessage(message as Json);
      completionText += messageText(message as ChatMessage);
    }
  }

  if (typeof out["usage"] !== "object" || out["usage"] === null) {
    const promptTokens = estimateTokens(promptText);
    const completionTokens = estimateTokens(completionText);
    out["usage"] = {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      estimated: true,
    };
  }

  out["choices"] = choices;
  return out;
}

export function normaliseChunk(chunk: Json, resolved: ResolvedModel): Json {
  chunk["object"] = "chat.completion.chunk";
  chunk["model"] = fullModelId(resolved.providerId, resolved.modelId);
  if (typeof chunk["created"] !== "number") chunk["created"] = Math.floor(Date.now() / 1000);
  if (typeof chunk["id"] !== "string") chunk["id"] = `chatcmpl-${randomUUID()}`;

  const choices = Array.isArray(chunk["choices"]) ? (chunk["choices"] as Json[]) : [];
  for (const [index, choice] of choices.entries()) {
    if (typeof choice["index"] !== "number") choice["index"] = index;
    const delta = choice["delta"];
    if (typeof delta !== "object" || delta === null) {
      choice["delta"] = {};
      continue;
    }
    // OpenAI's documented role frame carries an empty string, not null, and a
    // null field is what strict clients reject as an invalid stream event.
    // Drop the nulls instead of shipping them: the field is optional.
    const record = delta as Json;
    if (record["content"] === null) record["content"] = "";
    if (record["role"] === null) delete record["role"];
    if (record["reasoning_content"] === null) delete record["reasoning_content"];
    normaliseArguments(record["tool_calls"]);
  }
  chunk["choices"] = choices;
  return chunk;
}
