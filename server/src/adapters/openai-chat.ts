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

function keepKeys(record: Json, allowed: readonly string[]): void {
  const keys = new Set(allowed);
  for (const key of Object.keys(record)) if (!keys.has(key)) delete record[key];
}

function normaliseUsageDetails(usage: Json): void {
  const fields: Record<string, string[]> = {
    prompt_tokens_details: ["cached_tokens", "audio_tokens"],
    completion_tokens_details: ["reasoning_tokens", "audio_tokens", "accepted_prediction_tokens", "rejected_prediction_tokens"],
  };
  for (const [key, allowed] of Object.entries(fields)) {
    const details = usage[key];
    if (typeof details !== "object" || details === null || Array.isArray(details)) { delete usage[key]; continue; }
    const record = details as Json;
    keepKeys(record, allowed);
    for (const [field, value] of Object.entries(record)) {
      if (!Number.isInteger(value) || (value as number) < 0) delete record[field];
    }
  }
}

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
  message["role"] = "assistant";
  normaliseArguments(message["tool_calls"]);
  if (typeof message["function_call"] === "object" && message["function_call"] !== null) {
    const legacy = message["function_call"] as Json;
    if (typeof legacy["arguments"] === "object" && legacy["arguments"] !== null) legacy["arguments"] = JSON.stringify(legacy["arguments"]);
    if (typeof legacy["arguments"] !== "string") legacy["arguments"] = "{}";
    keepKeys(legacy, ["name", "arguments"]);
  }
  if (Array.isArray(message["tool_calls"])) {
    for (const [index, value] of message["tool_calls"].entries()) {
      if (typeof value !== "object" || value === null) continue;
      const call = value as Json;
      if (typeof call["id"] !== "string" || call["id"].length === 0) call["id"] = `call_${randomUUID().replaceAll("-", "")}`;
      call["type"] = "function";
      const fn = typeof call["function"] === "object" && call["function"] !== null ? call["function"] as Json : {};
      if (typeof fn["name"] !== "string") fn["name"] = `function_${index}`;
      if (typeof fn["arguments"] !== "string") fn["arguments"] = "{}";
      call["function"] = fn;
      keepKeys(fn, ["name", "arguments"]);
      keepKeys(call, ["id", "type", "function"]);
    }
  }
  if (typeof message["refusal"] !== "string") delete message["refusal"];
  keepKeys(message, ["role", "content", "refusal", "tool_calls", "function_call", "audio", "annotations"]);
}

export function normaliseCompletion(
  payload: Json,
  resolved: ResolvedModel,
  promptText: string,
): Json {
  const out: Json = { ...payload };
  out["id"] = typeof out["id"] === "string" && out["id"].length > 0 ? out["id"] : `chatcmpl-${randomUUID()}`;
  out["object"] = "chat.completion";
  out["created"] = Number.isInteger(out["created"]) ? out["created"] : Math.floor(Date.now() / 1000);
  out["model"] = fullModelId(resolved.providerId, resolved.modelId);
  if (typeof out["system_fingerprint"] !== "string") delete out["system_fingerprint"];
  if (!["auto", "default", "flex", "scale", "priority", "fast"].includes(String(out["service_tier"]))) delete out["service_tier"];

  const choices = Array.isArray(out["choices"]) ? (out["choices"] as Json[]) : [];
  let completionText = "";

  for (const [index, choice] of choices.entries()) {
    if (typeof choice !== "object" || choice === null) continue;
    if (!Number.isInteger(choice["index"]) || (choice["index"] as number) < 0) choice["index"] = index;
    const message = choice["message"];
    if (typeof message === "object" && message !== null) {
      normaliseMessage(message as Json);
      completionText += messageText(message as ChatMessage);
    }
    const hasToolCalls = typeof message === "object" && message !== null && Array.isArray((message as Json)["tool_calls"]) && ((message as Json)["tool_calls"] as unknown[]).length > 0;
    if (typeof choice["finish_reason"] !== "string" || choice["finish_reason"].length === 0) {
      choice["finish_reason"] = hasToolCalls ? "tool_calls" : "stop";
    } else {
      const reason = (choice["finish_reason"] as string).toLowerCase();
      if (["eos", "end_turn", "stop_sequence"].includes(reason)) choice["finish_reason"] = "stop";
      else if (["max_tokens", "max_output_tokens"].includes(reason)) choice["finish_reason"] = "length";
      else if (reason === "tool_use") choice["finish_reason"] = "tool_calls";
      else if (reason === "function_call") choice["finish_reason"] = hasToolCalls ? "tool_calls" : "function_call";
      else if (["safety", "blocked"].includes(reason)) choice["finish_reason"] = "content_filter";
      else if (!["stop", "length", "tool_calls", "content_filter"].includes(reason)) {
        choice["finish_reason"] = hasToolCalls ? "tool_calls" : "stop";
      }
    }
    keepKeys(choice, ["index", "message", "finish_reason"]);
  }

  const usage = typeof out["usage"] === "object" && out["usage"] !== null ? out["usage"] as Json : {};
  const estimatedPrompt = estimateTokens(promptText);
  const estimatedCompletion = estimateTokens(completionText);
  const providerPrompt = usage["prompt_tokens"];
  const providerCompletion = usage["completion_tokens"];
  const isPromptValid = Number.isInteger(providerPrompt) && (providerPrompt as number) >= 0;
  const isCompletionValid = Number.isInteger(providerCompletion) && (providerCompletion as number) >= 0;
  const promptTokens = isPromptValid ? providerPrompt as number : estimatedPrompt;
  const completionTokens = isCompletionValid ? providerCompletion as number : estimatedCompletion;
  usage["prompt_tokens"] = promptTokens;
  usage["completion_tokens"] = completionTokens;
  usage["total_tokens"] = promptTokens + completionTokens;
  normaliseUsageDetails(usage);
  keepKeys(usage, ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_tokens_details", "completion_tokens_details"]);
  out["usage"] = usage;

  out["choices"] = choices;
  keepKeys(out, ["id", "object", "created", "model", "choices", "usage", "system_fingerprint", "service_tier"]);
  return out;
}

export interface StreamIdentity { id?: string; created?: number; }

export function normaliseChunk(chunk: Json, resolved: ResolvedModel, identity: StreamIdentity = {}): Json {
  chunk["object"] = "chat.completion.chunk";
  chunk["model"] = fullModelId(resolved.providerId, resolved.modelId);
  if (typeof identity.id === "string") chunk["id"] = identity.id;
  else if (typeof chunk["id"] !== "string" || chunk["id"].length === 0) chunk["id"] = `chatcmpl-${randomUUID()}`;
  if (typeof identity.created === "number") chunk["created"] = identity.created;
  else if (!Number.isInteger(chunk["created"])) chunk["created"] = Math.floor(Date.now() / 1000);
  if (typeof chunk["system_fingerprint"] !== "string") delete chunk["system_fingerprint"];
  if (!["auto", "default", "flex", "scale", "priority", "fast"].includes(String(chunk["service_tier"]))) delete chunk["service_tier"];

  const choices = Array.isArray(chunk["choices"]) ? (chunk["choices"] as Json[]) : [];
  for (const [index, choice] of choices.entries()) {
    if (typeof choice["index"] !== "number") choice["index"] = index;
    const delta = choice["delta"];
    if (typeof delta !== "object" || delta === null) {
      choice["delta"] = {};
      keepKeys(choice, ["index", "delta", "finish_reason"]);
      continue;
    }
    // OpenAI's documented role frame carries an empty string, not null, and a
    // null field is what strict clients reject as an invalid stream event.
    // Drop the nulls instead of shipping them: the field is optional.
    const record = delta as Json;
    if (record["role"] !== undefined && record["role"] !== "assistant") delete record["role"];
    if (record["content"] === null) record["content"] = "";
    if (record["role"] === null) delete record["role"];
    normaliseArguments(record["tool_calls"]);
    if (Array.isArray(record["tool_calls"])) {
      for (const [position, value] of record["tool_calls"].entries()) {
        if (typeof value !== "object" || value === null) continue;
        const call = value as Json;
        if (!Number.isInteger(call["index"]) || (call["index"] as number) < 0) call["index"] = position;
        if (call["type"] !== undefined && call["type"] !== "function") call["type"] = "function";
        if (typeof call["function"] === "object" && call["function"] !== null) {
          keepKeys(call["function"] as Json, ["name", "arguments"]);
        }
        keepKeys(call, ["index", "id", "type", "function"]);
      }
    }
    if (typeof record["function_call"] === "object" && record["function_call"] !== null) {
      const legacy = record["function_call"] as Json;
      if (typeof legacy["arguments"] === "object" && legacy["arguments"] !== null) legacy["arguments"] = JSON.stringify(legacy["arguments"]);
      keepKeys(legacy, ["name", "arguments"]);
    }
    keepKeys(record, ["role", "content", "refusal", "tool_calls", "function_call", "audio"]);
    if (choice["finish_reason"] !== undefined && choice["finish_reason"] !== null && typeof choice["finish_reason"] !== "string") choice["finish_reason"] = null;
    if (typeof choice["finish_reason"] === "string") {
      const reason = (choice["finish_reason"] as string).toLowerCase();
      if (["eos", "end_turn", "stop_sequence"].includes(reason)) choice["finish_reason"] = "stop";
      else if (["max_tokens", "max_output_tokens"].includes(reason)) choice["finish_reason"] = "length";
      else if (reason === "tool_use") choice["finish_reason"] = "tool_calls";
      else if (reason === "function_call") choice["finish_reason"] = "function_call";
      else if (["safety", "blocked"].includes(reason)) choice["finish_reason"] = "content_filter";
      else if (!["stop", "length", "tool_calls", "content_filter"].includes(reason)) choice["finish_reason"] = "stop";
    }
    keepKeys(choice, ["index", "delta", "finish_reason"]);
  }
  chunk["choices"] = choices;
  if (typeof chunk["usage"] === "object" && chunk["usage"] !== null) {
    const usage = chunk["usage"] as Json;
    if (Number.isInteger(usage["prompt_tokens"]) && Number.isInteger(usage["completion_tokens"])) {
      usage["total_tokens"] = (usage["prompt_tokens"] as number) + (usage["completion_tokens"] as number);
    }
    normaliseUsageDetails(usage);
    keepKeys(usage, ["prompt_tokens", "completion_tokens", "total_tokens", "prompt_tokens_details", "completion_tokens_details"]);
  }
  keepKeys(chunk, ["id", "object", "created", "model", "choices", "usage", "system_fingerprint", "service_tier"]);
  return chunk;
}
