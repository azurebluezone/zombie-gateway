/**
 * Server-sent events reader.
 *
 * One parser for every upstream that speaks `text/event-stream`. It separates
 * framing (blank-line boundaries, `data:` fields, `[DONE]`) from interpretation,
 * so the OpenAI and Anthropic paths cannot disagree about where an event ends.
 *
 * A malformed event is reported to the caller and skipped: one bad frame must
 * not kill a stream that is otherwise healthy.
 */

import type { IncomingMessage } from "node:http";

export interface SseFrame {
  event: string | null;
  data: string;
}

export interface SseOptions {
  signal?: AbortSignal;
  onFrame: (frame: SseFrame) => void | Promise<void>;
  onMalformed?: (data: string) => void;
}

const decoder = new TextDecoder("utf-8");

export async function readSse(
  body: IncomingMessage,
  options: SseOptions,
): Promise<void> {
  let buffer = "";

  const flush = async (block: string): Promise<void> => {
    let event: string | null = null;
    const data: string[] = [];

    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }

    if (data.length === 0) return;
    const joined = data.join("\n");
    if (joined === "[DONE]") return;

    try {
      await options.onFrame({ event, data: joined });
    } catch (error) {
      options.onMalformed?.(joined);
      void error;
    }
  };

  for await (const piece of body as AsyncIterable<Buffer>) {
    if (options.signal?.aborted) return;
    buffer += decoder.decode(piece, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      if (block.trim().length > 0) await flush(block);
      boundary = buffer.indexOf("\n\n");
    }
  }

  buffer += decoder.decode();
  if (buffer.trim().length > 0) await flush(buffer);
}
