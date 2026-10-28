/**
 * POST /v1/chat/completions
 *
 * Pipeline: resolve model -> resolve session -> build upstream body -> stream or
 * buffer -> normalise back into the OpenAI schema -> log every outcome.
 *
 * Invariants:
 *  - The upstream model id is never rewritten on the wire; only the public id is
 *    qualified as "<provider>/<model>".
 *  - Text decays through a streaming TextDecoder, so a multi-byte UTF-8
 *    sequence (Bengali included) is never split across chunks.
 *  - The client sees the same response shape whether the upstream is a
 *    llama.cpp server, Ollama or a remote gateway.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { GatewayConfig, ProviderConfig } from "../config.ts";
import { fullModelId, hashPrompt, resolveModel, type ResolvedModel } from "./catalog.ts";
import {
  loadHistory,
  persistNewMessages,
  recordRequest,
  resolveSession,
  type ChatMessage,
} from "./session.ts";
import { openUpstream, readBody } from "../transport/request.ts";
import { assertTransportSupported } from "../transport/index.ts";
import { GatewayError, errorFromUpstream, streamInterrupted, toEnvelope } from "./errors.ts";
import { logEvent } from "./logger.ts";
import { driverFor } from "../providers/index.ts";
import { beginSse, endSse, writeEvent } from "./stream.ts";
import {
  messageText,
  normaliseChunk,
  normaliseCompletion,
  type Json as AdapterJson,
} from "../adapters/openai-chat.ts";
import { contextHeaders, contextOverflowError, judgeUsage, planContext, type ContextPlan } from "./context.ts";
import { estimateTokens } from "./tokens.ts";
import {
  emptyReport,
  mergeReports,
  reportHeader,
  sanitizeJson,
  sanitizeText,
  type SanitizeMode,
  type SanitizeReport,
} from "./sanitize.ts";
import type { ProviderRegistry } from "./registry.ts";
import type { LoadedIdentity } from "../identity.ts";
import { injectPolicy, policyHeader, type LoadedPolicy, type PolicyInjection } from "./policy.ts";

type Json = AdapterJson;

export interface AppContext {
  config: GatewayConfig;
  /** Live map owned by the registry; admin changes are visible immediately. */
  providers: Map<string, ProviderConfig>;
  registry: ProviderRegistry;
  identity: LoadedIdentity;
  /** Loaded once at boot; immutable for the process lifetime. */
  policy: LoadedPolicy;
}

const MAX_NON_STREAM_BYTES = 64 * 1024 * 1024;

const PASSTHROUGH = [
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "repeat_penalty",
  "seed",
  "response_format",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "reasoning_effort",
  "user",
  "n",
] as const;

function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function toolCallingBlocked(resolved: ResolvedModel, body: Json): void {
  const tools = body["tools"];
  if (!Array.isArray(tools) || tools.length === 0) return;
  if (resolved.caps.length === 0) return;
  if (resolved.caps.includes("tools")) return;

  throw new GatewayError({
    message: `Model "${fullModelId(resolved.providerId, resolved.modelId)}" does not declare tool support; remove "tools" or declare CP_*_CAPS=tools for this provider`,
    status: 400,
    code: "invalid_request_error",
    param: "tools",
    providerId: resolved.providerId,
  });
}

/**
 * Response-side hygiene.
 *
 * A hidden instruction in model output is as dangerous downstream as one pasted
 * into a prompt: the next agent reads the output as trusted text. Non-stream
 * responses are therefore cleaned in place, and the counts are published in
 * `x-sanitize-output`.
 *
 * Streamed text is scanned but never rewritten here. A carrier can straddle two
 * chunks, and judging half of a ZWJ pair would either strip real Bengali
 * orthography or let the other half through; the handler logs the finding and
 * leaves the bytes alone.
 */
function scrubCompletion(completion: Json, mode: SanitizeMode): SanitizeReport {
  const report = emptyReport(mode);
  if (mode === "off") return report;

  const choices = Array.isArray(completion["choices"]) ? (completion["choices"] as Json[]) : [];
  for (const choice of choices) {
    if (typeof choice !== "object" || choice === null) continue;
    const message = choice["message"];
    if (typeof message !== "object" || message === null) continue;
    const record = message as Json;

    if (typeof record["content"] === "string") {
      const result = sanitizeText(record["content"], mode);
      mergeReports(report, result.report);
      record["content"] = result.text;
    }

    const calls = record["tool_calls"];
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (typeof call !== "object" || call === null) continue;
      const fn = (call as Json)["function"];
      if (typeof fn !== "object" || fn === null) continue;
      const args = (fn as Json)["arguments"];
      if (typeof args !== "string") continue;
      const result = sanitizeText(args, mode);
      mergeReports(report, result.report);
      (fn as Json)["arguments"] = result.text;
    }
  }

  return report;
}

export async function handleChatCompletions(
  ctx: AppContext,
  req: IncomingMessage,
  res: ServerResponse,
  body: Json,
): Promise<void> {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const wantsStream = body["stream"] === true;

  let resolved: ResolvedModel | null = null;
  let provider: ProviderConfig | null = null;
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
  let promptText = "";
  let incoming: ChatMessage[] = [];
  let report = emptyReport(ctx.config.sanitize);
  let planRef: ContextPlan | null = null;
  let policyRef: PolicyInjection | null = null;
  // True until the upstream body ends without reaching its own terminator. The
  // catch block uses it to tell "the provider hung up on us" from "the provider
  // answered badly and we said so".
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
      logEvent("error", "chat.failed", {
        requestId,
        provider: resolved?.providerId ?? null,
        model: resolved?.modelId ?? null,
        status,
        code: errorCode,
        message: detail,
        upstreamStatus,
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
    body = sanitized.value;

    if (report.detected > 0 || report.trailingMark) {
      logEvent("warn", "sanitize.prompt", {
        requestId,
        route: "/v1/chat/completions",
        header: reportHeader(report),
        detected: report.detected,
        removed: report.removed,
        hiddenPayload: report.hiddenPayload,
        keyCollision: report.keyCollision,
      });
    }

    resolved = resolveModel(typeof body["model"] === "string" ? body["model"] : "");

    incoming = Array.isArray(body["messages"]) ? (body["messages"] as ChatMessage[]) : [];

    const configured = ctx.providers.get(resolved.providerId);
    if (!configured) {
      throw new GatewayError({
        message: `Provider "${resolved.providerId}" is in the catalogue but not configured in this process`,
        status: 503,
        code: "provider_not_found",
        providerId: resolved.providerId,
      });
    }
    provider = configured;
    assertTransportSupported(provider.transport, provider.id);

    toolCallingBlocked(resolved, body);

    const session = resolveSession({
      sessionId: headerValue(req, "x-session-id") ?? (typeof body["session_id"] === "string" ? body["session_id"] : null),
      clientId: headerValue(req, "x-client-id"),
      userAgent: headerValue(req, "user-agent"),
      remoteAddr: req.socket.remoteAddress ?? null,
    });
    sessionId = session.id;
    clientSig = session.clientSig;

    let history = incoming;
    if (history.length === 0) {
      history = loadHistory(session.id);
    }
    if (history.length === 0) {
      throw new GatewayError({
        message: "Request contains no messages and the session has no stored history",
        status: 400,
        code: "invalid_request_error",
        param: "messages",
      });
    }

    // The behaviour layer is added to the copy that goes on the wire. `history`
    // stays clean so the session store never replays the injected text.
    const injection = injectPolicy(history, ctx.policy, headerValue(req, "x-policy"));
    const outgoing = injection.messages;
    policyRef = injection;
    if (injection.state === "applied") {
      logEvent("info", "policy.injected", {
        requestId,
        route: "/v1/chat/completions",
        sha256: ctx.policy.sha256,
        tokens: injection.tokens,
      });
    }

    // Hash and measure what is actually sent. When messages arrive empty the
    // session replay is the prompt, and hashing an empty array would describe
    // a request that never happened.
    const promptPayload = JSON.stringify(outgoing);
    promptBytes = Buffer.byteLength(promptPayload);
    promptHash = hashPrompt(promptPayload);
    promptText = outgoing.map(messageText).join("\n");

    const upstreamBody: Json = {
      model: resolved.upstreamId,
      messages: outgoing,
      stream: wantsStream,
    };
    for (const key of PASSTHROUGH) {
      if (body[key] !== undefined) upstreamBody[key] = body[key];
    }
    if (wantsStream) upstreamBody["stream_options"] = { include_usage: true };

    const plan = planContext(resolved, outgoing, upstreamBody, {
      enforce: ctx.config.contextEnforce,
      assumedLimit: 0,
      outputReserve: ctx.config.outputReserve,
    });
    planRef = plan;

    logEvent("info", "chat.context", {
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
      enforced: plan.enforced,
    });

    // Refusing is the only honest option when the engine would otherwise drop
    // the middle of the prompt and answer the wrong question.
    if (plan.enforced && !plan.fits) throw contextOverflowError(resolved, plan);

    persistNewMessages(session.id, history, fullModelId(resolved.providerId, resolved.modelId));

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

    if (!wantsStream) {
      const raw = await readBody(upstream.body, MAX_NON_STREAM_BYTES);
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

      const normalised = normaliseCompletion(parsed, resolved, promptText);
      const outputReport = scrubCompletion(normalised, ctx.config.sanitize);
      if (outputReport.detected > 0 || outputReport.trailingMark) {
        logEvent("warn", "sanitize.response", {
          requestId,
          route: "/v1/chat/completions",
          header: reportHeader(outputReport),
          detected: outputReport.detected,
          removed: outputReport.removed,
        });
      }

      const usage = normalised["usage"] as Json | undefined;
      promptTokens = typeof usage?.["prompt_tokens"] === "number" ? usage["prompt_tokens"] : null;
      completionTokens =
        typeof usage?.["completion_tokens"] === "number" ? usage["completion_tokens"] : null;

      const choices = normalised["choices"] as Json[];
      const first = choices[0];
      const message = first?.["message"];
      if (typeof message === "object" && message !== null) {
        persistNewMessages(
          session.id,
          [{ role: "assistant", content: (message as Json)["content"] ?? "", tool_calls: (message as Json)["tool_calls"] }],
          fullModelId(resolved.providerId, resolved.modelId),
        );
      }

      // An estimated usage block is our own arithmetic; judging it against the
      // estimate would compare a guess with itself and always look healthy.
      const usageEstimated = usage?.["estimated"] === true;
      const verdict = judgeUsage(plan, usageEstimated ? null : promptTokens, completionTokens);
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
        "x-request-id": requestId,
        ...contextHeaders(plan, verdict),
        "x-sanitize": reportHeader(report),
        "x-sanitize-output": reportHeader(outputReport),
        "x-policy": policyHeader(injection),
        ...(promptTokens !== null ? { "x-context-actual": String(promptTokens) } : {}),
      });
      res.end(JSON.stringify(normalised));
      status = 200;
      logEvent("info", "chat.completed", {
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

    beginSse(res, {
      "x-request-id": requestId,
      ...contextHeaders(plan),
      "x-sanitize": reportHeader(report),
      "x-policy": policyHeader(injection),
    });
    ttfbMs = null;

    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let sawUsage = false;
    let textOut = "";
    // OpenAI streams a tool call as fragments keyed by `index`. Keeping the
    // fragments would persist a broken history, so they are accumulated into
    // one complete call per index before anything is stored.
    const streamedToolCalls = new Map<
      number,
      { id: string | null; name: string; arguments: string }
    >();

    const emit = async (chunk: Json): Promise<void> => {
      const normalised = normaliseChunk(chunk, resolved as ResolvedModel);
      const usage = normalised["usage"];
      if (typeof usage === "object" && usage !== null) {
        sawUsage = true;
        const parsedUsage = usage as Json;
        if (typeof parsedUsage["prompt_tokens"] === "number") promptTokens = parsedUsage["prompt_tokens"];
        if (typeof parsedUsage["completion_tokens"] === "number") {
          completionTokens = parsedUsage["completion_tokens"];
        }
      }

      for (const choice of (normalised["choices"] as Json[]) ?? []) {
        const delta = choice["delta"] as Json | undefined;
        if (!delta) continue;
        if (typeof delta["content"] === "string") textOut += delta["content"];
        const toolCalls = delta["tool_calls"];
        if (Array.isArray(toolCalls)) {
          for (const [position, call] of toolCalls.entries()) {
            if (typeof call !== "object" || call === null) continue;
            const record = call as Json;
            const index = typeof record["index"] === "number" ? record["index"] : position;
            const current = streamedToolCalls.get(index) ?? {
              id: null,
              name: "",
              arguments: "",
            };
            if (typeof record["id"] === "string" && record["id"].length > 0) {
              current.id = record["id"];
            }
            const fn = record["function"];
            if (typeof fn === "object" && fn !== null) {
              const name = (fn as Json)["name"];
              if (typeof name === "string" && name.length > 0) {
                if (current.name.length === 0) current.name = name;
                else if (name !== current.name) {
                  if (name.startsWith(current.name)) current.name = name;
                  else if (!current.name.endsWith(name)) current.name += name;
                }
              }
              const args = (fn as Json)["arguments"];
              if (typeof args === "string") current.arguments += args;
              else if (typeof args === "object" && args !== null) {
                current.arguments += JSON.stringify(args);
              }
            }
            streamedToolCalls.set(index, current);
          }
        }
      }

      await writeEvent(res, normalised);
      chunkCount += 1;
      if (ttfbMs === null) ttfbMs = Date.now() - startedAt;
    };

    for await (const piece of upstream.body as AsyncIterable<Buffer>) {
      buffer += decoder.decode(piece, { stream: true });
      buffer = buffer.replace(/\r\n/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        const data = rawEvent
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");

        if (data === "[DONE]") {
          // Terminator handled by the writer below.
        } else if (data.length > 0) {
          try {
            await emit(JSON.parse(data) as Json);
          } catch {
            // A single malformed event must not kill a healthy stream.
            logEvent("warn", "chat.stream.bad_event", { requestId, bytes: data.length });
          }
        }

        boundary = buffer.indexOf("\n\n");
      }
    }

    buffer += decoder.decode();
    if (buffer.trim().length > 0) {
      const tail = buffer
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (tail && tail !== "[DONE]") {
        try {
          await emit(JSON.parse(tail) as Json);
        } catch {
          /* ignore trailing partial frame */
        }
      }
    }

    upstreamDrained = true;

    if (!sawUsage) {
      const promptTokensFinal = estimateTokens(promptText);
      const completionTokensFinal = estimateTokens(textOut);
      promptTokens = promptTokensFinal;
      completionTokens = completionTokensFinal;
      await writeEvent(res, {
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: fullModelId(resolved.providerId, resolved.modelId),
        choices: [],
        usage: {
          prompt_tokens: promptTokensFinal,
          completion_tokens: completionTokensFinal,
          total_tokens: promptTokensFinal + completionTokensFinal,
          estimated: true,
        },
      });
    }

    // The stream itself cannot be rewritten: a carrier may straddle two chunks,
    // and half a ZWJ pair is worse than the carrier. The full text is still
    // scanned here, and the copy written to session history is cleaned so the
    // next turn does not replay the payload.
    const streamed = sanitizeText(textOut, ctx.config.sanitize);
    if (streamed.report.detected > 0 || streamed.report.trailingMark) {
      logEvent("warn", "sanitize.response", {
        requestId,
        route: "/v1/chat/completions",
        stream: true,
        header: reportHeader(streamed.report),
        detected: streamed.report.detected,
        removed: streamed.report.removed,
        note: "stream bytes already delivered; history copy cleaned",
      });
    }

    if (sawUsage) {
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

    const completedToolCalls = [...streamedToolCalls.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, call]) => ({
        id: call.id ?? `call_${randomUUID().slice(0, 8)}`,
        type: "function",
        function: {
          name: call.name,
          arguments: sanitizeText(
            call.arguments.length > 0 ? call.arguments : "{}",
            ctx.config.sanitize,
          ).text,
        },
      }));

    if (streamed.text.length > 0 || completedToolCalls.length > 0) {
      persistNewMessages(
        session.id,
        [{
          role: "assistant",
          content: streamed.text,
          tool_calls: completedToolCalls.length > 0 ? completedToolCalls : undefined,
        }],
        fullModelId(resolved.providerId, resolved.modelId),
      );
    }

    // The upstream sentinel is consumed above and never forwarded verbatim:
    // the client always receives exactly one terminating frame from the gateway.
    if (!res.writableEnded) endSse(res);

    status = 200;
    logEvent("info", "chat.completed", {
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
      sessionId,
    });
    finish();
  } catch (error) {
    // A client that walked away is not a gateway failure: recording it as 500
    // internal_error would put the peer's decision into our error budget.
    if (controller.signal.aborted) {
      status = 499;
      if (!res.writableEnded) res.end();
      logEvent("info", "chat.client_aborted", {
        requestId,
        provider: provider?.id ?? null,
        model: resolved?.modelId ?? null,
        durationMs: Date.now() - startedAt,
        chunks: chunkCount,
        sessionId,
      });
      finish();
      return;
    }

    // Once the upstream headers have arrived and its body stops early, the
    // transport error is the only explanation we have; report it as such
    // instead of leaking a bare "aborted" under internal_error.
    const mapped =
      !upstreamDrained &&
      upstreamStatus !== null &&
      provider !== null &&
      !(error instanceof GatewayError)
        ? streamInterrupted(provider.id, error)
        : error;
    const envelope = toEnvelope(mapped);

    if (!res.headersSent) {
      res.writeHead(envelope.status, {
        "content-type": "application/json; charset=utf-8",
        "x-request-id": requestId,
        "x-error-code": envelope.body.error.code,
        "x-sanitize": reportHeader(report),
        ...(planRef ? contextHeaders(planRef) : {}),
        ...(policyRef ? { "x-policy": policyHeader(policyRef) } : {}),
      });
      res.end(JSON.stringify(envelope.body));
    } else {
      const failure = new GatewayError({
        message: envelope.body.error.message,
        status: envelope.status,
        code: envelope.body.error.code,
      });
      await writeEvent(res, toEnvelope(failure).body).catch(() => undefined);
      if (!res.writableEnded) res.end();
    }

    finish(mapped);
  }
}
