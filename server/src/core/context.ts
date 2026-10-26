/**
 * Context-window ledger.
 *
 * A context window is a hard number owned by the engine, not by the gateway. The
 * failure this module prevents is the quiet one: a prompt that is slightly too
 * long, an engine that silently drops the middle, and a response that looks
 * healthy while the instruction was never seen.
 *
 * Three numbers are kept apart and all three are published:
 *   promptEstimate  what we think the messages cost (estimator, not tokenizer)
 *   toolsEstimate   what the tool schemas cost
 *   reserve         what the answer is allowed to consume
 * Their sum is compared with `models.context_length` from the catalogue. When the
 * limit is unknown the check is not enforced and says so, instead of inventing a
 * number and calling it a guarantee.
 */

import type { Json } from "../adapters/openai-chat.ts";
import type { ResolvedModel } from "./catalog.ts";
import type { ChatMessage } from "./session.ts";
import { GatewayError } from "./errors.ts";
import { estimateTokens } from "./tokens.ts";

export interface ContextPolicy {
  /** Refuse a request that cannot fit instead of letting the engine truncate. */
  enforce: boolean;
  /** Limit used when the catalogue has no context length. */
  assumedLimit: number;
  /** Minimum output reserve; a larger client `max_tokens` still wins. */
  outputReserve: number | null;
}

export interface ContextPlan {
  limit: number | null;
  limitSource: "catalog" | "assumed" | "unknown";
  promptEstimate: number;
  messageOverhead: number;
  toolsEstimate: number;
  images: number;
  imageEstimate: number;
  reserve: number;
  total: number;
  fits: boolean;
  overflowBy: number;
  enforced: boolean;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && "text" in part
          ? String((part as Json)["text"] ?? "")
          : "",
      )
      .join("");
  }
  if (content === null || content === undefined) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** ~4 tokens per message for role markers and separators (documented estimate). */
const PER_MESSAGE_OVERHEAD = 4;

/**
 * An image is not text, so no character heuristic can price it. Counting it as
 * zero would be a silent under-estimate that only shows up as truncated answers,
 * so a conservative flat bound is used and published as its own header field.
 */
const PER_IMAGE_ESTIMATE = 1024;

function imagesOf(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const type = (part as Json)["type"];
    if (type === "image_url" || type === "image") count += 1;
  }
  return count;
}

function autoReserve(limit: number): number {
  return Math.min(8192, Math.max(256, Math.floor(limit / 8)));
}

export function planContext(
  resolved: ResolvedModel,
  messages: ChatMessage[],
  body: Json,
  policy: ContextPolicy,
): ContextPlan {
  let promptEstimate = 0;
  let messageOverhead = 0;
  let images = 0;

  for (const message of messages) {
    promptEstimate += estimateTokens(textOf(message.content));
    messageOverhead += PER_MESSAGE_OVERHEAD;
    images += imagesOf(message.content);
    if (message.tool_calls !== undefined) {
      try {
        promptEstimate += estimateTokens(JSON.stringify(message.tool_calls));
      } catch {
        /* an unserialisable tool call was never sent upstream anyway */
      }
    }
  }
  const imageEstimate = images * PER_IMAGE_ESTIMATE;

  let toolsEstimate = 0;
  if (Array.isArray(body["tools"]) && body["tools"].length > 0) {
    try {
      toolsEstimate = estimateTokens(JSON.stringify(body["tools"]));
    } catch {
      toolsEstimate = 0;
    }
  }

  const catalogLimit = resolved.contextLength;
  const limit = catalogLimit ?? (policy.assumedLimit > 0 ? policy.assumedLimit : null);
  const limitSource: ContextPlan["limitSource"] =
    catalogLimit !== null ? "catalog" : policy.assumedLimit > 0 ? "assumed" : "unknown";

  const requested =
    typeof body["max_tokens"] === "number"
      ? body["max_tokens"]
      : typeof body["max_completion_tokens"] === "number"
        ? body["max_completion_tokens"]
        : null;

  // The reserve is the larger of what the client asked for and what the policy
  // guarantees. Letting a fixed policy number shrink a client's own max_tokens
  // would under-count the request and hide a real overflow.
  const reserve = Math.max(
    requested ?? 0,
    policy.outputReserve ?? (limit !== null ? autoReserve(limit) : 0),
  );

  const total = promptEstimate + messageOverhead + toolsEstimate + imageEstimate + reserve;
  const enforced = policy.enforce && limit !== null;

  return {
    limit,
    limitSource,
    promptEstimate,
    messageOverhead,
    toolsEstimate,
    images,
    imageEstimate,
    reserve,
    total,
    fits: limit === null ? true : total <= limit,
    overflowBy: limit === null ? 0 : Math.max(0, total - limit),
    enforced,
  };
}

export interface UsageVerdict {
  /** actual / estimated prompt tokens; null when either side is missing. */
  ratio: number | null;
  /** The upstream counted far more prompt tokens than we estimated. */
  drift: boolean;
  /** prompt + completion exceeded the known window: evidence of silent truncation. */
  overflow: boolean;
}

/**
 * Cross-checks the estimator against the engine's own usage numbers. A large
 * ratio is not an error in the response; it is evidence that our estimate is
 * unusable for this model and must be logged, not hidden.
 */
export function judgeUsage(
  plan: ContextPlan,
  promptTokens: number | null,
  completionTokens: number | null,
): UsageVerdict {
  const estimate = plan.promptEstimate + plan.messageOverhead;
  const ratio = promptTokens !== null && estimate > 0 ? promptTokens / estimate : null;

  const drift = ratio !== null && promptTokens !== null && promptTokens > 512 && ratio > 1.6;

  const total =
    promptTokens !== null && completionTokens !== null
      ? promptTokens + completionTokens
      : null;

  return {
    ratio,
    drift,
    overflow: plan.limit !== null && total !== null && total > plan.limit,
  };
}

export function contextHeaders(plan: ContextPlan, verdict?: UsageVerdict): Record<string, string> {
  const headers: Record<string, string> = {
    "x-context-limit": plan.limit === null ? "unknown" : String(plan.limit),
    "x-context-limit-source": plan.limitSource,
    "x-context-prompt-estimate": String(plan.promptEstimate + plan.messageOverhead),
    "x-context-tools-estimate": String(plan.toolsEstimate),
    "x-context-image-estimate": String(plan.imageEstimate),
    "x-context-reserve": String(plan.reserve),
  };
  if (plan.overflowBy > 0) headers["x-context-overflow-by"] = String(plan.overflowBy);
  if (verdict?.ratio !== null && verdict?.ratio !== undefined) {
    headers["x-context-estimate-ratio"] = verdict.ratio.toFixed(2);
  }
  if (verdict?.drift) headers["x-context-estimate-drift"] = "1";
  return headers;
}

/**
 * The rejection a caller gets when nothing would fit. The message spells out
 * every component, because "context length exceeded" alone hides which number
 * was too big: the prompt, the tool schemas or the requested output reserve.
 */
export function contextOverflowError(resolved: ResolvedModel, plan: ContextPlan): GatewayError {
  return new GatewayError({
    message:
      `Context window overflow: prompt ~${plan.promptEstimate + plan.messageOverhead} tokens + ` +
      `tools ~${plan.toolsEstimate} + images ~${plan.imageEstimate} + reserve ${plan.reserve} = ${plan.total}, ` +
      `limit ${plan.limit} for "${resolved.providerId}/${resolved.modelId}". ` +
      `Shorten the prompt or lower max_tokens.`,
    status: 400,
    code: "context_length_exceeded",
    param: "messages",
    providerId: resolved.providerId,
  });
}
