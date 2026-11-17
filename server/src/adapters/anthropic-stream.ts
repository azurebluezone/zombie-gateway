/**
 * Anthropic streaming translator.
 *
 * OpenAI streams deltas; Anthropic streams *indexed content blocks*. A text
 * block must start before its first delta and stop before the next block, so the
 * writer owns block indices instead of letting them leak into the handler.
 *
 * Tool calls are streamed by OpenAI as argument fragments. Anthropic expects a
 * complete `input` object at block start, so arguments are accumulated and
 * emitted as one `input_json_delta` per call. That is a deliberate trade: one
 * extra frame per tool call buys a valid block for every client, including the
 * ones that do not implement fragment reassembly.
 */

import { randomUUID } from "node:crypto";
import type { Json } from "./openai-chat.ts";
import { mapStopReason } from "./anthropic.ts";
import { estimateTokens } from "../core/tokens.ts";

export type EventSink = (event: string, payload: unknown) => Promise<void>;

interface ToolAccumulator {
  id: string;
  name: string;
  arguments: string;
}

export interface StreamResult {
  text: string;
  toolCalls: Json[];
  inputTokens: number | null;
  outputTokens: number | null;
  /** True only when the engine itself reported usage; false means we estimated. */
  usageFromUpstream: boolean;
}

export class AnthropicStream {
  private readonly sink: EventSink;
  private readonly model: string;
  private readonly messageId: string;
  private nextIndex = 0;
  private textIndex: number | null = null;
  private textOpen = false;
  private readonly tools = new Map<number, ToolAccumulator>();
  private text = "";
  private inputTokens: number | null = null;
  private outputTokens: number | null = null;
  private usageFromUpstream = false;

  constructor(sink: EventSink, model: string, messageId: string, inputEstimate: number) {
    this.sink = sink;
    this.model = model;
    this.messageId = messageId;
    this.inputTokens = inputEstimate > 0 ? inputEstimate : null;
  }

  async start(): Promise<void> {
    await this.sink("message_start", {
      type: "message_start",
      message: {
        id: this.messageId,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.inputTokens ?? 0, output_tokens: 0 },
      },
    });
  }

  async onChunk(chunk: Json): Promise<void> {
    const usage = chunk["usage"];
    if (typeof usage === "object" && usage !== null) {
      const parsed = usage as Json;
      if (typeof parsed["prompt_tokens"] === "number") {
        this.inputTokens = parsed["prompt_tokens"];
        this.usageFromUpstream = true;
      }
      if (typeof parsed["completion_tokens"] === "number") {
        this.outputTokens = parsed["completion_tokens"];
        this.usageFromUpstream = true;
      }
    }

    const choices = Array.isArray(chunk["choices"]) ? (chunk["choices"] as Json[]) : [];
    for (const choice of choices) {
      const delta = choice["delta"];
      if (typeof delta !== "object" || delta === null) continue;
      const record = delta as Json;

      const content = record["content"];
      if (typeof content === "string" && content.length > 0) {
        await this.appendText(content);
      }

      const toolCalls = record["tool_calls"];
      if (Array.isArray(toolCalls)) {
        for (const entry of toolCalls) {
          if (typeof entry !== "object" || entry === null) continue;
          this.accumulate(entry as Json);
        }
      }
    }
  }

  private async appendText(text: string): Promise<void> {
    if (!this.textOpen) {
      this.textIndex = this.nextIndex;
      this.nextIndex += 1;
      await this.sink("content_block_start", {
        type: "content_block_start",
        index: this.textIndex,
        content_block: { type: "text", text: "" },
      });
      this.textOpen = true;
    }
    this.text += text;
    await this.sink("content_block_delta", {
      type: "content_block_delta",
      index: this.textIndex,
      delta: { type: "text_delta", text },
    });
  }

  private accumulate(call: Json): void {
    const index = typeof call["index"] === "number" ? call["index"] : 0;
    const current =
      this.tools.get(index) ?? { id: `toolu_${randomUUID()}`, name: "", arguments: "" };

    if (typeof call["id"] === "string" && call["id"].length > 0) current.id = call["id"];

    const fn = call["function"];
    if (typeof fn === "object" && fn !== null) {
      const record = fn as Json;
      const name = record["name"];
      if (typeof name === "string" && name.length > 0) {
        // Engines disagree: some resend the whole name, some stream fragments.
        // Prefix replacement covers both without duplicating a repeated name.
        if (current.name.length === 0) current.name = name;
        else if (name !== current.name) {
          if (name.startsWith(current.name)) current.name = name;
          else if (!current.name.endsWith(name)) current.name += name;
        }
      }
      const args = record["arguments"];
      if (typeof args === "string") current.arguments += args;
      else if (typeof args === "object" && args !== null) current.arguments += JSON.stringify(args);
    }

    this.tools.set(index, current);
  }

  async finish(finishReason: string | null): Promise<StreamResult> {
    if (this.textOpen && this.textIndex !== null) {
      await this.sink("content_block_stop", {
        type: "content_block_stop",
        index: this.textIndex,
      });
      this.textOpen = false;
    }

    const toolCalls: Json[] = [];
    for (const [index, tool] of [...this.tools.entries()].sort(([a], [b]) => a - b)) {
      void index;
      const blockIndex = this.nextIndex;
      this.nextIndex += 1;

      await this.sink("content_block_start", {
        type: "content_block_start",
        index: blockIndex,
        content_block: {
          type: "tool_use",
          id: tool.id,
          name: tool.name,
          input: {},
        },
      });
      await this.sink("content_block_delta", {
        type: "content_block_delta",
        index: blockIndex,
        delta: {
          type: "input_json_delta",
          partial_json: tool.arguments.length > 0 ? tool.arguments : "{}",
        },
      });
      await this.sink("content_block_stop", {
        type: "content_block_stop",
        index: blockIndex,
      });

      toolCalls.push({
        id: tool.id,
        type: "function",
        function: { name: tool.name, arguments: tool.arguments.length > 0 ? tool.arguments : "{}" },
      });
    }

    const stopReason = mapStopReason(finishReason, toolCalls.length > 0);
    const outputTokens =
      this.outputTokens ?? Math.max(1, estimateTokens(this.text));

    const usage: Json = { output_tokens: outputTokens };
    // Only echo input_tokens when the engine reported them: repeating the
    // gateway's own estimate here would look like a measurement.
    if (this.usageFromUpstream && this.inputTokens !== null) {
      usage["input_tokens"] = this.inputTokens;
    }

    await this.sink("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage,
    });
    await this.sink("message_stop", { type: "message_stop" });

    return {
      text: this.text,
      toolCalls,
      inputTokens: this.inputTokens,
      outputTokens,
      usageFromUpstream: this.usageFromUpstream,
    };
  }
}
