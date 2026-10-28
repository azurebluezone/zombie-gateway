/**
 * POST /v1/messages — Anthropic Messages API, translated to the OpenAI path.
 *
 * This is an integration layer, not a second inference stack: the model is
 * resolved from the same catalogue, the bytes travel through the same transport,
 * and the same request log records the call.
 *
 * Deliberate property: this route is **stateless**. Anthropic clients resend the
 * full transcript, and a tool_result cannot be reconstructed from stored text
 * without corrupting replay, so the gateway attributes the call to a session but
 * does not persist turns. `/v1/chat/completions` remains the stateful path.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppContext } from "./chat.ts";
import { fullModelId, hashPrompt, resolveModel, type ResolvedModel } from "./catalog.ts";
import { contextHeaders, contextOverflowError, judgeUsage, planContext, type ContextPlan } from "./context.ts";
import { GatewayError, errorFromUpstream, streamInterrupted, toEnvelope } from "./errors.ts";
import { logEvent } from "./logger.ts";
import { recordRequest, resolveSession } from "./session.ts";
import {
  emptyReport,
  mergeReports,
  reportHeader,
  sanitizeJson,
  sanitizeText,
  scanText,
  type SanitizeMode,
  type SanitizeReport,
} from "./sanitize.ts";
import { beginSse, writeNamedEvent } from "./stream.ts";
import { estimateTokens } from "./tokens.ts";
import { openUpstream, readBody } from "../transport/request.ts";
import { assertTransportSupported } from "../transport/index.ts";
import { driverFor } from "../providers/index.ts";
import { AnthropicStream } from "../adapters/anthropic-stream.ts";
import { toAnthropicError, toAnthropicMessage, translateRequest } from "../adapters/anthropic.ts";
import type { Json } from "../adapters/openai-chat.ts";
import { readSse } from "../adapters/sse.ts";
import { injectPolicy, policyHeader, type PolicyInjection } from "./policy.ts";

const MAX_NON_STREAM_BYTES = 64 * 1024 * 1024;

function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/**
 * Response-side hygiene for Anthropic-shaped output.
 *
 * Text blocks are cleaned and counted; a tool call's `input` is cleaned with the
 * same JSON walker, because an argument value is a string too. The stream path
 * scans without rewriting for the same reason as the OpenAI path: a carrier can
 * straddle two chunks.
 */
function scrubAnthropicMessage(message: Json, mode: SanitizeMode): SanitizeReport {
  const report = emptyReport(mode);
  if (mode === "off") return report;

  const content = Array.isArray(message["content"]) ? (message["content"] as Json[]) : [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    if (block["type"] === "text" && typeof block["text"] === "string") {
      const result = sanitizeText(block["text"], mode);
      mergeReports(report, result.report);
      block["text"] = result.text;
    }
    if (block["type"] === "tool_use" && typeof block["input"] === "object" && block["input"] !== null) {
      const result = sanitizeJson(block["input"], mode);
      mergeReports(report, result.report);
      block["input"] = result.value;
    }
  }

  return report;
}

export async function handleMessages(
  ctx: AppContext,
  req: IncomingMessage,
  res: ServerResponse,
  body: Json,
): Promise<void> {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const wantsStream = body["stream"] === true;

  let resolved: ResolvedModel | null = null;
  let sessionId: string | null = null;
  let clientSig: string | null = null;
  let upstreamStatus: number | null = null;
  let ttfbMs: number | null = null;
  let chunkCount = 0;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let status = 500;
  let errorCode: string | null = null;
  let detail: string | null = null;
  let promptBytes = 0;
  let promptHash: string | null = null;
  let report = emptyReport(ctx.config.sanitize);
  let plan: ContextPlan | null = null;
  let policyRef: PolicyInjection | null = null;
  // Set once the upstream stream ends on its own. Until then a transport error
  // means the provider hung up mid-stream.
  let upstreamDrained = false;

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  const finish = (error?: unknown): void => {
    if (error) {
      const envelope = toEnvelope(error);
      status = envelope.status;
      errorCode = envelope.body.error.code;
      detail = envelope.body.error.message;
      logEvent("error", "messages.failed", {
        requestId,
        provider: resolved?.providerId ?? null,
        model: resolved?.modelId ?? null,
        status,
        code: errorCode,
        message: detail,
        sessionId,
        durationMs: Date.now() - startedAt,
      });
    }

    recordRequest({
      requestId,
      sessionId,
      clientSig,
      providerId: resolved?.providerId ?? null,
      modelId: resolved?.modelId ?? null,
      stream: wantsStream,
      status,
      errorCode,
      upstreamStatus,
      durationMs: Date.now() - startedAt,
      ttfbMs,
      chunkCount,
      promptBytes,
      promptHash,
      promptTokens,
      completionTokens,
      detail,
    });
  };

  try {
    const sanitized = sanitizeJson(body, ctx.config.sanitize);
    report = sanitized.report;
    const clean = sanitized.value;
    promptBytes = Buffer.byteLength(JSON.stringify(clean));
    promptHash = hashPrompt(JSON.stringify(clean));

    if (report.detected > 0 || report.trailingMark) {
      logEvent("warn", "sanitize.prompt", {
        requestId,
        route: "/v1/messages",
        header: reportHeader(report),
        detected: report.detected,
        removed: report.removed,
        hiddenPayload: report.hiddenPayload,
      });
    }

    resolved = resolveModel(typeof clean["model"] === "string" ? clean["model"] : "");
    const provider = ctx.providers.get(resolved.providerId);
    if (!provider) {
      throw new GatewayError({
        message: `Provider "${resolved.providerId}" is in the catalogue but not configured in this process`,
        status: 503,
        code: "provider_not_found",
        providerId: resolved.providerId,
      });
    }
    assertTransportSupported(provider.transport, provider.id);

    const translation = translateRequest(clean);
    const messages = translation.system
      ? [{ role: "system", content: translation.system }, ...translation.messages]
      : translation.messages;

    // Same behaviour layer as the chat route. This route is stateless, so the
    // client's own transcript is the only way the text could double; the marker
    // check inside injectPolicy covers that case.
    const injection = injectPolicy(messages, ctx.policy, headerValue(req, "x-policy"));
    const outgoing = injection.messages;
    policyRef = injection;
    if (injection.state === "applied") {
      logEvent("info", "policy.injected", {
        requestId,
        route: "/v1/messages",
        sha256: ctx.policy.sha256,
        tokens: injection.tokens,
      });
    }

    const contextPlan = planContext(
      resolved,
      outgoing,
      { ...clean, max_tokens: translation.maxTokens, tools: translation.options["tools"] },
      {
        enforce: ctx.config.contextEnforce,
        assumedLimit: 0,
        outputReserve: ctx.config.outputReserve,
      },
    );
    plan = contextPlan;

    logEvent("info", "messages.context", {
      requestId,
      provider: resolved.providerId,
      model: resolved.modelId,
      limit: plan.limit,
      limitSource: plan.limitSource,
      estimate: plan.promptEstimate + plan.messageOverhead,
      tools: plan.toolsEstimate,
      images: plan.imageEstimate,
      reserve: plan.reserve,
      total: plan.total,
      fits: plan.fits,
    });

    if (plan.enforced && !plan.fits) throw contextOverflowError(resolved, plan);

    const metadata = typeof clean["metadata"] === "object" && clean["metadata"] !== null
      ? (clean["metadata"] as Json)
      : {};

    // `metadata.user_id` identifies a person, not a conversation, so it becomes
    // the client id. Treating it as a session id would merge every conversation
    // that person ever had into one row.
    const session = resolveSession({
      sessionId: headerValue(req, "x-session-id"),
      clientId:
        headerValue(req, "x-client-id") ??
        (typeof metadata["user_id"] === "string" ? metadata["user_id"] : null),
      userAgent: headerValue(req, "user-agent"),
      remoteAddr: req.socket.remoteAddress ?? null,
    });
    sessionId = session.id;
    clientSig = session.clientSig;

    const upstreamBody: Json = {
      model: resolved.upstreamId,
      messages: outgoing,
      max_tokens: translation.maxTokens,
      stream: wantsStream,
      ...translation.options,
    };
    if (wantsStream) upstreamBody["stream_options"] = { include_usage: true };

    const upstream = await openUpstream(provider, {
      method: "POST",
      path: driverFor(provider.kind).chatPath,
      body: JSON.stringify(upstreamBody),
      accept: wantsStream ? "text/event-stream" : "application/json",
      signal: controller.signal,
    });
    upstreamStatus = upstream.status;

    if (upstream.status >= 400) {
      const raw = await readBody(upstream.body, 1024 * 1024);
      throw errorFromUpstream(provider.id, upstream.status, raw);
    }

    const baseHeaders: Record<string, string> = {
      ...contextHeaders(plan),
      "x-request-id": requestId,
      "x-sanitize": reportHeader(report),
      "x-policy": policyHeader(injection),
    };

    const publicModel = fullModelId(resolved.providerId, resolved.modelId);
    const messageId = `msg_${requestId.replace(/-/g, "").slice(0, 24)}`;

    if (!wantsStream) {
      const raw = await readBody(upstream.body, MAX_NON_STREAM_BYTES);
      ttfbMs = Date.now() - startedAt;

      let parsed: Json;
      try {
        parsed = JSON.parse(raw) as Json;
      } catch {
        throw new GatewayError({
          message: `Provider "${provider.id}" returned a non-JSON body`,
          status: 502,
          code: "internal_error",
          providerId: provider.id,
        });
      }

      const message = toAnthropicMessage(parsed, publicModel, {
        input: plan.promptEstimate + plan.messageOverhead + plan.toolsEstimate,
        output: estimateTokens(raw),
      });
      const outputReport = scrubAnthropicMessage(message, ctx.config.sanitize);
      if (outputReport.detected > 0 || outputReport.trailingMark) {
        logEvent("warn", "sanitize.response", {
          requestId,
          route: "/v1/messages",
          header: reportHeader(outputReport),
          detected: outputReport.detected,
          removed: outputReport.removed,
        });
      }

      // An upstream that reports no usage leaves our estimate in place; judging
      // an estimate against itself would always look healthy.
      const upstreamUsage =
        typeof parsed["usage"] === "object" && parsed["usage"] !== null;

      const usage = message["usage"] as Json;
      promptTokens = typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : null;
      completionTokens =
        typeof usage["output_tokens"] === "number" ? usage["output_tokens"] : null;

      const verdict = judgeUsage(
        plan,
        upstreamUsage ? promptTokens : null,
        upstreamUsage ? completionTokens : null,
      );
      if (verdict.drift) {
        logEvent("warn", "context.estimate_drift", {
          requestId,
          provider: resolved.providerId,
          model: resolved.modelId,
          estimate: plan.promptEstimate + plan.messageOverhead,
          actual: promptTokens,
          ratio: verdict.ratio,
        });
      }
      if (verdict.overflow) {
        logEvent("error", "context.upstream_overflow", {
          requestId,
          provider: resolved.providerId,
          model: resolved.modelId,
          limit: plan.limit,
          prompt: promptTokens,
          completion: completionTokens,
        });
      }

      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        ...baseHeaders,
        ...contextHeaders(plan, verdict),
        "x-sanitize-output": reportHeader(outputReport),
        ...(promptTokens !== null ? { "x-context-actual": String(promptTokens) } : {}),
      });
      res.end(JSON.stringify(message));
      status = 200;

      logEvent("info", "messages.completed", {
        requestId,
        provider: provider.id,
        model: resolved.modelId,
        stream: false,
        status,
        durationMs: Date.now() - startedAt,
        promptTokens,
        completionTokens,
        sessionId,
      });
      finish();
      return;
    }

    beginSse(res, baseHeaders);
    const writer = new AnthropicStream(
      (event, payload) => writeNamedEvent(res, event, payload),
      publicModel,
      messageId,
      plan.promptEstimate + plan.messageOverhead + plan.toolsEstimate,
    );
    await writer.start();

    let finishReason: string | null = null;

    await readSse(upstream.body, {
      signal: controller.signal,
      onMalformed: (data) =>
        logEvent("warn", "messages.stream.bad_event", { requestId, bytes: data.length }),
      onFrame: async ({ data }) => {
        const chunk = JSON.parse(data) as Json;
        if (ttfbMs === null) ttfbMs = Date.now() - startedAt;
        const choices = Array.isArray(chunk["choices"]) ? (chunk["choices"] as Json[]) : [];
        const reason = choices[0]?.["finish_reason"];
        if (typeof reason === "string") finishReason = reason;
        await writer.onChunk(chunk);
        chunkCount += 1;
      },
    });

    upstreamDrained = true;

    const result = await writer.finish(finishReason);
    promptTokens = result.inputTokens;
    completionTokens = result.outputTokens;

    const streamReport = scanText(result.text);
    if (streamReport.detected > 0 || streamReport.trailingMark) {
      logEvent("warn", "sanitize.response", {
        requestId,
        route: "/v1/messages",
        stream: true,
        header: reportHeader(streamReport),
        detected: streamReport.detected,
        removed: 0,
        note: "stream bytes already delivered",
      });
    }

    if (result.usageFromUpstream) {
      const verdict = judgeUsage(plan, promptTokens, completionTokens);
      if (verdict.drift) {
        logEvent("warn", "context.estimate_drift", {
          requestId,
          provider: resolved.providerId,
          model: resolved.modelId,
          estimate: plan.promptEstimate + plan.messageOverhead,
          actual: promptTokens,
          ratio: verdict.ratio,
        });
      }
      if (verdict.overflow) {
        logEvent("error", "context.upstream_overflow", {
          requestId,
          provider: resolved.providerId,
          model: resolved.modelId,
          limit: plan.limit,
          prompt: promptTokens,
          completion: completionTokens,
        });
      }
    }

    status = 200;
    logEvent("info", "messages.completed", {
      requestId,
      provider: provider.id,
      model: resolved.modelId,
      stream: true,
      status,
      chunks: chunkCount,
      ttfbMs,
      durationMs: Date.now() - startedAt,
      promptTokens,
      completionTokens,
      toolCalls: result.toolCalls.length,
      sessionId,
    });

    if (!res.writableEnded) res.end();
    finish();
  } catch (error) {
    // The peer leaving is not a gateway failure; it is the peer's decision and
    // belongs in its own counter, not in the 5xx rate.
    if (controller.signal.aborted) {
      status = 499;
      if (!res.writableEnded) res.end();
      logEvent("info", "messages.client_aborted", {
        requestId,
        provider: resolved?.providerId ?? null,
        model: resolved?.modelId ?? null,
        durationMs: Date.now() - startedAt,
        chunks: chunkCount,
        sessionId,
      });
      finish();
      return;
    }

    const mapped =
      !upstreamDrained && upstreamStatus !== null && !(error instanceof GatewayError)
        ? streamInterrupted(resolved?.providerId ?? "unknown", error)
        : error;
    const envelope = toEnvelope(mapped);
    if (!res.headersSent) {
      res.writeHead(envelope.status, {
        "content-type": "application/json; charset=utf-8",
        "x-request-id": requestId,
        "x-error-code": envelope.body.error.code,
        "x-sanitize": reportHeader(report),
        ...(plan ? contextHeaders(plan) : {}),
        ...(policyRef ? { "x-policy": policyHeader(policyRef) } : {}),
      });
      res.end(
        JSON.stringify(toAnthropicError(envelope.status, envelope.body.error.message, envelope.body.error.code)),
      );
    } else {
      await writeNamedEvent(
        res,
        "error",
        toAnthropicError(envelope.status, envelope.body.error.message, envelope.body.error.code),
      ).catch(() => undefined);
      if (!res.writableEnded) res.end();
    }
    finish(mapped);
  }
}

/**
 * POST /v1/messages/count_tokens
 *
 * Returns our estimate, labelled as such in a header. A count_tokens endpoint
 * that claims exactness while using a character heuristic would be a small lie
 * that becomes a large one when a client budgets against it.
 */
export async function handleCountTokens(
  ctx: AppContext,
  req: IncomingMessage,
  res: ServerResponse,
  body: Json,
): Promise<void> {
  void req;
  const sanitized = sanitizeJson(body, ctx.config.sanitize);
  const clean = sanitized.value;

  const resolved = resolveModel(typeof clean["model"] === "string" ? clean["model"] : "");
  const translation = translateRequest(clean);
  const messages = translation.system
    ? [{ role: "system", content: translation.system }, ...translation.messages]
    : translation.messages;

  // Count what the gateway would actually send, policy included; a budget that
  // ignores the behaviour layer would promise room the real call does not have.
  const injection = injectPolicy(messages, ctx.policy, headerValue(req, "x-policy"));
  const outgoing = injection.messages;

  const plan = planContext(
    resolved,
    outgoing,
    { ...clean, max_tokens: translation.maxTokens, tools: translation.options["tools"] },
    { enforce: ctx.config.contextEnforce, assumedLimit: 0, outputReserve: ctx.config.outputReserve },
  );

  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "x-token-estimate": "1",
    "x-context-limit": plan.limit === null ? "unknown" : String(plan.limit),
    "x-sanitize": reportHeader(sanitized.report),
    "x-policy": policyHeader(injection),
  });
  res.end(
    JSON.stringify({
      input_tokens: plan.promptEstimate + plan.messageOverhead + plan.toolsEstimate,
      estimated: true,
      note: "Character-based estimate; engine chat-template and system-prompt tokens are not included. usage.prompt_tokens from a completion is authoritative.",
    }),
  );
}
