/**
 * Transport registry.
 *
 * Each transport is a separate module so the wire behaviour stays auditable:
 *   request.ts    http | https | uds (all HTTP/1.1 framing, SSE downstream)
 *   websocket.ts  reserved for duplex audio endpoints only
 *
 * gRPC and stdio are intentionally absent: neither is a chat-completions
 * transport for these engines. stdio belongs to MCP tool servers, not inference.
 */

import type { TransportKind } from "../config.ts";
import { GatewayError } from "../core/errors.ts";

export const SUPPORTED_TRANSPORTS: readonly TransportKind[] = ["http", "https", "uds"];

export function assertTransportSupported(kind: TransportKind, providerId: string): void {
  if (SUPPORTED_TRANSPORTS.includes(kind)) return;
  throw new GatewayError({
    message:
      kind === "ws"
        ? `Provider "${providerId}": websocket is reserved for duplex audio; chat completions must use http, https or uds`
        : `Provider "${providerId}": transport "${kind}" is not a chat-completions transport`,
    status: 501,
    code: "not_implemented",
    providerId,
  });
}

export { openUpstream, readBody, probeJson, closeTransports } from "./request.ts";
