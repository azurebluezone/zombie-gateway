/**
 * Server-side SSE writer.
 *
 * Every chunk is flushed as soon as it is produced: no buffering, no Nagle
 * delay, no coalescing. A client typing in a terminal must see the first token
 * before the model finishes the sentence.
 */

import { once } from "node:events";
import type { ServerResponse } from "node:http";

export function beginSse(res: ServerResponse, extra: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...extra,
  });
  res.flushHeaders();
  res.socket?.setNoDelay(true);
}

export async function writeAsync(res: ServerResponse, chunk: string): Promise<void> {
  if (res.writableEnded || res.destroyed) return;
  const accepted = res.write(chunk, "utf8");
  if (accepted) return;
  await once(res, "drain");
}

export function writeEvent(res: ServerResponse, payload: unknown): Promise<void> {
  return writeAsync(res, `data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Named SSE event.
 *
 * Anthropic clients dispatch on `event:`; OpenAI clients only read `data:`.
 * Sending the name for one protocol and omitting it for the other is not a
 * cosmetic difference, it is the difference between a parsed stream and silence.
 */
export function writeNamedEvent(
  res: ServerResponse,
  event: string,
  payload: unknown,
): Promise<void> {
  return writeAsync(res, `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

export function endSse(res: ServerResponse): void {
  if (res.writableEnded) return;
  res.write("data: [DONE]\n\n");
  res.end();
}
