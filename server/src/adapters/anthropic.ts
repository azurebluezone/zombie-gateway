/**
 * Anthropic Messages adapter.
 *
 * Translation only: Anthropic request in, OpenAI chat-completions request out;
 * OpenAI response in, Anthropic response out. No transport, no session, no SQLite
 * here, which is what makes the mapping testable without an engine.
 *
 * Mapping decisions worth naming:
 *  - `tool_result` blocks become role:"tool" messages, because an OpenAI engine
 *    has no notion of a tool result nested inside a user turn;
 *  - a tool call whose arguments are not valid JSON is returned with
 *    `_raw_arguments`, never silently replaced by an empty object;
 *  - `stop_reason` is derived from tool presence first, then from finish_reason,
 *    since OpenAI reports "tool_calls" only for native tool engines.
 */

import { randomUUID } from "node:crypto";
import type { ChatMessage } from "../core/session.ts";
import type { Json } from "./openai-chat.ts";

export interface AnthropicTranslation {
  messages: ChatMessage[];
  system: string | null;
  maxTokens: number;
  options: Json;
}

function asRecord(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function textFromBlocks(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => {
      const record = asRecord(block);
      return record["type"] === "text" && typeof record["text"] === "string"
        ? record["text"]
        : "";
    })
    .join("");
}

function imagePart(block: Json): Json | null {
  const source = asRecord(block["source"]);
  if (source["type"] === "base64" && typeof source["data"] === "string") {
    const media = typeof source["media_type"] === "string" ? source["media_type"] : "image/png";
    return { type: "image_url", image_url: { url: `data:${media};base64,${source["data"]}` } };
  }
  if (source["type"] === "url" && typeof source["url"] === "string") {
    return { type: "image_url", image_url: { url: source["url"] } };
  }
  return null;
}

/** Anthropic tools carry `input_schema`; OpenAI wants `function.parameters`. */
function translateTools(tools: unknown): Json[] | null {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const out: Json[] = [];
  for (const entry of tools) {
    const tool = asRecord(entry);
    const name = typeof tool["name"] === "string" ? tool["name"] : null;
    if (!name) continue;
    out.push({
      type: "function",
      function: {
        name,
        description: typeof tool["description"] === "string" ? tool["description"] : "",
        parameters: asRecord(tool["input_schema"]),
      },
    });
  }
  return out.length > 0 ? out : null;
}

function translateToolChoice(choice: unknown): unknown {
  const record = asRecord(choice);
  const type = typeof record["type"] === "string" ? record["type"] : "";
  if (type === "auto") return "auto";
  if (type === "any") return "required";
  if (type === "none") return "none";
  if (type === "tool" && typeof record["name"] === "string") {
    return { type: "function", function: { name: record["name"] } };
  }
  return undefined;
}

function translateUserMessage(content: unknown): ChatMessage[] {
  if (typeof content === "string") return [{ role: "user", content }];
  if (!Array.isArray(content)) return [{ role: "user", content: "" }];

  const toolMessages: ChatMessage[] = [];
  const parts: Json[] = [];

  for (const entry of content) {
    const block = asRecord(entry);
    const type = block["type"];

    if (type === "text" && typeof block["text"] === "string") {
      parts.push({ type: "text", text: block["text"] });
      continue;
    }

    if (type === "image") {
      const part = imagePart(block);
      if (part) parts.push(part);
      continue;
    }

    if (type === "tool_result") {
      const toolCallId = typeof block["tool_use_id"] === "string" ? block["tool_use_id"] : "";
      const resultContent = block["content"];
      const text =
        typeof resultContent === "string"
          ? resultContent
          : Array.isArray(resultContent)
            ? textFromBlocks(resultContent)
            : JSON.stringify(resultContent ?? "");
      toolMessages.push({ role: "tool", content: text, tool_call_id: toolCallId });
      continue;
    }
    // Unknown block types are dropped on purpose: forwarding them would make the
    // engine parse a schema it never agreed to.
  }

  const messages: ChatMessage[] = [...toolMessages];

  if (parts.length === 1 && parts[0]?.["type"] === "text") {
    messages.push({ role: "user", content: String(parts[0]["text"] ?? "") });
  } else if (parts.length > 0) {
    messages.push({ role: "user", content: parts });
  }

  return messages.length > 0 ? messages : [{ role: "user", content: "" }];
}

function translateAssistantMessage(content: unknown): ChatMessage {
  if (typeof content === "string") return { role: "assistant", content };
  if (!Array.isArray(content)) return { role: "assistant", content: "" };

  let text = "";
  const toolCalls: Json[] = [];

  for (const entry of content) {
    const block = asRecord(entry);
    if (block["type"] === "text" && typeof block["text"] === "string") {
      text += block["text"];
      continue;
    }
    if (block["type"] === "tool_use") {
      const id = typeof block["id"] === "string" ? block["id"] : `toolu_${randomUUID()}`;
      const name = typeof block["name"] === "string" ? block["name"] : "";
      toolCalls.push({
        id,
        type: "function",
        function: { name, arguments: JSON.stringify(asRecord(block["input"])) },
      });
    }
  }

  const message: ChatMessage = { role: "assistant", content: text };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return message;
}

export function translateRequest(body: Json): AnthropicTranslation {
  const rawMessages = Array.isArray(body["messages"]) ? (body["messages"] as unknown[]) : [];
  const messages: ChatMessage[] = [];

  for (const entry of rawMessages) {
    const message = asRecord(entry);
    const role = message["role"];
    if (role === "user") {
      messages.push(...translateUserMessage(message["content"]));
    } else if (role === "assistant") {
      messages.push(translateAssistantMessage(message["content"]));
    }
    // Any other role is not part of the Anthropic schema; dropping it is safer
    // than guessing which OpenAI role the sender meant.
  }

  const rawSystem = body["system"];
  const system =
    typeof rawSystem === "string"
      ? rawSystem
      : Array.isArray(rawSystem)
        ? textFromBlocks(rawSystem)
        : null;

  const maxTokens =
    typeof body["max_tokens"] === "number" && body["max_tokens"] > 0
      ? Math.floor(body["max_tokens"])
      : 1024;

  const options: Json = {};
  for (const key of ["temperature", "top_p", "top_k"] as const) {
    if (typeof body[key] === "number") options[key] = body[key];
  }
  if (Array.isArray(body["stop_sequences"]) && body["stop_sequences"].length > 0) {
    options["stop"] = body["stop_sequences"];
  }
  const tools = translateTools(body["tools"]);
  if (tools) options["tools"] = tools;
  const toolChoice = translateToolChoice(body["tool_choice"]);
  if (toolChoice !== undefined) options["tool_choice"] = toolChoice;

  return { messages, system, maxTokens, options };
}

const STOP_REASON: Record<string, string> = {
  stop: "end_turn",
  length: "max_tokens",
  tool_calls: "tool_use",
  function_call: "tool_use",
  content_filter: "end_turn",
};

export function mapStopReason(
  finishReason: string | null,
  hasToolUse: boolean,
): string {
  if (hasToolUse) return "tool_use";
  if (!finishReason) return "end_turn";
  return STOP_REASON[finishReason] ?? "end_turn";
}

function parseArguments(raw: unknown): Json {
  if (typeof raw === "object" && raw !== null) return raw as Json;
  if (typeof raw !== "string" || raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Json)
      : { _raw_arguments: raw };
  } catch {
    // Never turn an unparseable tool call into an empty object: that would make
    // the model look like it decided to call the tool with no arguments.
    return { _raw_arguments: raw };
  }
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

export function toAnthropicMessage(
  completion: Json,
  model: string,
  estimatedTokens: { input: number; output: number },
): Json {
  const choices = Array.isArray(completion["choices"]) ? (completion["choices"] as Json[]) : [];
  const choice = choices[0] ?? {};
  const message = asRecord(choice["message"]);

  const content: Json[] = [];
  const text = typeof message["content"] === "string" ? message["content"] : "";
  if (text.length > 0) content.push({ type: "text", text });

  const toolCalls = Array.isArray(message["tool_calls"]) ? (message["tool_calls"] as Json[]) : [];
  for (const call of toolCalls) {
    const fn = asRecord(call["function"]);
    content.push({
      type: "tool_use",
      id: typeof call["id"] === "string" ? call["id"] : `toolu_${randomUUID()}`,
      name: typeof fn["name"] === "string" ? fn["name"] : "",
      input: parseArguments(fn["arguments"]),
    });
  }

  const usage = asRecord(completion["usage"]);
  const inputTokens =
    typeof usage["prompt_tokens"] === "number" ? usage["prompt_tokens"] : estimatedTokens.input;
  const outputTokens =
    typeof usage["completion_tokens"] === "number"
      ? usage["completion_tokens"]
      : estimatedTokens.output;

  const finishReason = typeof choice["finish_reason"] === "string" ? choice["finish_reason"] : null;
  const id = typeof completion["id"] === "string" ? completion["id"].replace(/^chatcmpl-/, "") : randomUUID();

  return {
    id: `msg_${id}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapStopReason(finishReason, content.some((block) => block["type"] === "tool_use")),
    stop_sequence: null,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

export function toAnthropicError(status: number, message: string, code: string): Json {
  const type =
    status === 401
      ? "authentication_error"
      : status === 403
        ? "permission_error"
        : status === 404 || status === 400
          ? "invalid_request_error"
          : status === 429
            ? "rate_limit_error"
            : status >= 500
              ? "api_error"
              : "invalid_request_error";
  void code;
  return { type: "error", error: { type, message } };
}
