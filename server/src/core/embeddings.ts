/**
 * POST /v1/embeddings
 *
 * A faithful pass-through with three gateway duties:
 *  - the model must exist in the catalogue and its provider must declare the
 *    `embeddings` capability (otherwise the request fails before the wire);
 *  - every input string is sanitised, because an embedding is often the first
 *    place a pasted document enters the system;
 *  - the response keeps the upstream vectors byte-for-byte while the model id is
 *    rewritten to the public "<provider>/<model>" form.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppContext } from "./chat.ts";
import { fullModelId, hashPrompt, resolveModel, type ResolvedModel } from "./catalog.ts";
import { GatewayError, errorFromUpstream, toEnvelope } from "./errors.ts";
import { logEvent } from "./logger.ts";
import { recordRequest } from "./session.ts";
import { reportHeader, sanitizeJson, emptyReport } from "./sanitize.ts";
import { openUpstream, readBody } from "../transport/request.ts";
import { assertTransportSupported } from "../transport/index.ts";
import { driverFor } from "../providers/index.ts";
import type { Json } from "../adapters/openai-chat.ts";
import { estimateTokens } from "./tokens.ts";

const MAX_EMBEDDING_BYTES = 64 * 1024 * 1024;
const MAX_INPUTS = 2048;

function inputStrings(input: unknown): string[] | null {
  if (typeof input === "string") return [input];
  if (Array.isArray(input)) {
    const out: string[] = [];
    for (const entry of input) {
      if (typeof entry !== "string") return null;
      out.push(entry);
    }
    return out;
  }
  return null;
}

export async function handleEmbeddings(
  ctx: AppContext,
  req: IncomingMessage,
  res: ServerResponse,
  body: Json,
): Promise<void> {
  const requestId = randomUUID();
  const startedAt = Date.now();

  let resolved: ResolvedModel | null = null;
  let upstreamStatus: number | null = null;
  let status = 500;
  let errorCode: string | null = null;
  let detail: string | null = null;
  let promptTokens: number | null = null;
  let tokenSource: "provider" | "estimate" | "none" = "none";
  let promptBytes = 0;
  let promptHash: string | null = null;
  let report = emptyReport(ctx.config.sanitize);

  const finish = (error?: unknown): void => {
    if (error) {
      const envelope = toEnvelope(error);
      status = envelope.status;
      errorCode = envelope.body.error.code;
      detail = envelope.body.error.message;
      logEvent("error", "embeddings.failed", {
        requestId,
        provider: resolved?.providerId ?? null,
        model: resolved?.modelId ?? null,
        status,
        code: errorCode,
        message: detail,
        durationMs: Date.now() - startedAt,
      });
    }

    recordRequest({
      requestId,
      sessionId: null,
      clientSig: null,
      providerId: resolved?.providerId ?? null,
      modelId: resolved?.modelId ?? null,
      stream: false,
      status,
      errorCode,
      upstreamStatus,
      durationMs: Date.now() - startedAt,
      ttfbMs: null,
      chunkCount: 0,
      promptBytes,
      promptHash,
      promptTokens,
      completionTokens: null,
      tokenSource,
      userId: (req as IncomingMessage & { gatewayUserId?: string }).gatewayUserId ?? null,
      detail,
    });
  };

  try {
    const sanitized = sanitizeJson(body, ctx.config.sanitize);
    report = sanitized.report;
    const clean = sanitized.value;
    promptBytes = Buffer.byteLength(JSON.stringify(clean));
    promptHash = hashPrompt(JSON.stringify(clean));

    if (report.detected > 0) {
      logEvent("warn", "sanitize.prompt", {
        requestId,
        route: "/v1/embeddings",
        header: reportHeader(report),
        detected: report.detected,
        removed: report.removed,
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

    if (resolved.caps.length > 0 && !resolved.caps.includes("embeddings")) {
      throw new GatewayError({
        message:
          `Model "${fullModelId(resolved.providerId, resolved.modelId)}" does not declare the ` +
          `"embeddings" capability. Declare it with POST /admin/providers/:id {"caps":[...]} or use an embedding model.`,
        status: 400,
        code: "invalid_request_error",
        param: "model",
        providerId: resolved.providerId,
      });
    }

    const inputs = inputStrings(clean["input"]);
    if (inputs === null || inputs.length === 0) {
      throw new GatewayError({
        message: "Field 'input' must be a string or an array of strings",
        status: 400,
        code: "invalid_request_error",
        param: "input",
      });
    }
    if (inputs.length > MAX_INPUTS) {
      throw new GatewayError({
        message: `Field 'input' exceeds ${MAX_INPUTS} strings`,
        status: 400,
        code: "invalid_request_error",
        param: "input",
      });
    }

    const upstreamBody: Json = {
      model: resolved.upstreamId,
      input: inputs.length === 1 && typeof clean["input"] === "string" ? inputs[0] : inputs,
    };
    if (typeof clean["encoding_format"] === "string") {
      upstreamBody["encoding_format"] = clean["encoding_format"];
    }
    if (typeof clean["dimensions"] === "number") upstreamBody["dimensions"] = clean["dimensions"];
    if (typeof clean["user"] === "string") upstreamBody["user"] = clean["user"];

    const upstream = await openUpstream(provider, {
      method: "POST",
      path: driverFor(provider.kind).embeddingsPath,
      body: JSON.stringify(upstreamBody),
      accept: "application/json",
    });
    upstreamStatus = upstream.status;

    const raw = await readBody(upstream.body, MAX_EMBEDDING_BYTES);
    if (upstream.status >= 400) throw errorFromUpstream(provider.id, upstream.status, raw);

    let parsed: Json;
    try {
      parsed = JSON.parse(raw) as Json;
    } catch {
      throw new GatewayError({
        message: `Provider "${provider.id}" returned a non-JSON embeddings body`,
        status: 502,
        code: "internal_error",
        providerId: provider.id,
      });
    }

    if (!Array.isArray(parsed["data"])) {
      throw new GatewayError({
        message: `Provider "${provider.id}" returned no 'data' array for embeddings`,
        status: 502,
        code: "internal_error",
        providerId: provider.id,
      });
    }
    if (parsed["data"].length !== inputs.length) {
      throw new GatewayError({
        message: `Provider "${provider.id}" returned ${parsed["data"].length} embeddings for ${inputs.length} input(s)`,
        status: 502,
        code: "provider_error",
        providerId: provider.id,
      });
    }
    for (const [index, item] of parsed["data"].entries()) {
      const vector = typeof item === "object" && item !== null ? (item as Json)["embedding"] : null;
      if (!Array.isArray(vector) || !vector.every((value: unknown) => typeof value === "number" && Number.isFinite(value))) {
        throw new GatewayError({
          message: `Provider "${provider.id}" returned a malformed embedding at index ${index}`,
          status: 502,
          code: "provider_error",
          providerId: provider.id,
        });
      }
      const record = item as Json;
      record["object"] = "embedding";
      record["index"] = Number.isInteger(record["index"]) && (record["index"] as number) >= 0 ? record["index"] : index;
      for (const key of Object.keys(record)) if (!["object", "index", "embedding"].includes(key)) delete record[key];
    }
    parsed["object"] = "list";
    parsed["model"] = fullModelId(resolved.providerId, resolved.modelId);

    const usage = parsed["usage"];
    if (typeof usage === "object" && usage !== null) {
      const tokens = (usage as Json)["prompt_tokens"];
      if (Number.isInteger(tokens) && (tokens as number) >= 0) promptTokens = tokens as number;
    }
    const usageSource = promptTokens === null ? "estimate" : "provider";
    if (promptTokens === null) promptTokens = estimateTokens(inputs.join("\n"));
    const normalizedUsage = typeof parsed["usage"] === "object" && parsed["usage"] !== null ? parsed["usage"] as Json : {};
    normalizedUsage["prompt_tokens"] = promptTokens;
    normalizedUsage["total_tokens"] = promptTokens;
    for (const key of Object.keys(normalizedUsage)) if (!["prompt_tokens", "total_tokens"].includes(key)) delete normalizedUsage[key];
    parsed["usage"] = normalizedUsage;
    for (const key of Object.keys(parsed)) if (!["object", "data", "model", "usage"].includes(key)) delete parsed[key];
    tokenSource = usageSource;

    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "x-request-id": requestId,
      "x-sanitize": reportHeader(report),
      "x-embeddings-count": String((parsed["data"] as unknown[]).length),
      "x-usage-source": usageSource,
    });
    res.end(JSON.stringify(parsed));
    status = 200;

    logEvent("info", "embeddings.completed", {
      requestId,
      provider: provider.id,
      model: resolved.modelId,
      inputs: inputs.length,
      status,
      durationMs: Date.now() - startedAt,
      promptTokens,
    });
    finish();
  } catch (error) {
    const envelope = toEnvelope(error);
    if (!res.headersSent) {
      res.writeHead(envelope.status, {
        "content-type": "application/json; charset=utf-8",
        "x-request-id": requestId,
        "x-sanitize": reportHeader(report),
      });
      res.end(JSON.stringify(envelope.body));
    } else if (!res.writableEnded) {
      res.end();
    }
    finish(error);
  }
}
