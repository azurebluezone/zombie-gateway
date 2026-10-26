/**
 * Every failure leaves the gateway as an OpenAI-shaped error envelope.
 * Internal reasons are preserved for logs, never leaked to clients.
 */

export type ErrorCode =
  | "invalid_request_error"
  | "invalid_api_key"
  | "model_not_found"
  | "provider_not_found"
  | "provider_exists"
  | "provider_error"
  | "provider_unreachable"
  | "provider_timeout"
  | "rate_limit_exceeded"
  | "context_length_exceeded"
  | "sync_in_progress"
  | "unsupported"
  | "unsupported_transport"
  | "unauthorized"
  | "not_implemented"
  | "internal_error";

export interface ErrorEnvelope {
  error: {
    message: string;
    type: string;
    param: string | null;
    code: ErrorCode;
  };
}

export class GatewayError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly param: string | null;
  readonly providerId: string | null;
  readonly upstreamStatus: number | null;
  readonly retryable: boolean;

  constructor(options: {
    message: string;
    status: number;
    code: ErrorCode;
    param?: string | null;
    providerId?: string | null;
    upstreamStatus?: number | null;
    retryable?: boolean;
    cause?: unknown;
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GatewayError";
    this.status = options.status;
    this.code = options.code;
    this.param = options.param ?? null;
    this.providerId = options.providerId ?? null;
    this.upstreamStatus = options.upstreamStatus ?? null;
    this.retryable = options.retryable ?? false;
  }
}

const STATUS_BY_UPSTREAM: Record<number, { code: ErrorCode; retryable: boolean }> = {
  400: { code: "invalid_request_error", retryable: false },
  401: { code: "invalid_api_key", retryable: false },
  403: { code: "invalid_api_key", retryable: false },
  404: { code: "model_not_found", retryable: false },
  408: { code: "provider_timeout", retryable: true },
  413: { code: "context_length_exceeded", retryable: false },
  422: { code: "invalid_request_error", retryable: false },
  429: { code: "rate_limit_exceeded", retryable: true },
  500: { code: "internal_error", retryable: true },
  502: { code: "provider_unreachable", retryable: true },
  503: { code: "provider_unreachable", retryable: true },
  504: { code: "provider_timeout", retryable: true },
};

export function errorFromUpstream(
  providerId: string,
  status: number,
  rawBody: string,
): GatewayError {
  const mapping = STATUS_BY_UPSTREAM[status] ?? {
    code: status >= 500 ? ("internal_error" as ErrorCode) : ("invalid_request_error" as ErrorCode),
    retryable: status >= 500,
  };

  let message = `Upstream provider "${providerId}" returned ${status}`;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    const upstreamMessage = extractMessage(parsed);
    if (upstreamMessage) message = upstreamMessage;
  } catch {
    const trimmed = rawBody.trim();
    if (trimmed) message = trimmed.slice(0, 500);
  }

  return new GatewayError({
    message,
    status,
    code: mapping.code,
    providerId,
    upstreamStatus: status,
    retryable: mapping.retryable,
  });
}

function extractMessage(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const direct = record["message"];
  if (typeof direct === "string" && direct.length > 0) return direct;
  const error = record["error"];
  if (typeof error === "string" && error.length > 0) return error;
  if (typeof error === "object" && error !== null) {
    const nested = (error as Record<string, unknown>)["message"];
    if (typeof nested === "string" && nested.length > 0) return nested;
  }
  return null;
}

export function toEnvelope(error: unknown): { status: number; body: ErrorEnvelope } {
  if (error instanceof GatewayError) {
    return {
      status: error.status,
      body: {
        error: {
          message: error.message,
          type: error.status >= 500 ? "server_error" : "invalid_request_error",
          param: error.param,
          code: error.code,
        },
      },
    };
  }

  const message = error instanceof Error ? error.message : "Unknown gateway failure";
  return {
    status: 500,
    body: {
      error: {
        message,
        type: "server_error",
        param: null,
        code: "internal_error",
      },
    },
  };
}
