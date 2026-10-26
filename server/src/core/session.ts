/**
 * Session store.
 *
 * A session is model-agnostic on purpose: history, client metadata and turn
 * count belong to the conversation, while the model is a property of a single
 * request. Switching model mid-session therefore cannot corrupt replay order.
 */

import { createHash, randomUUID } from "node:crypto";
import { execute, queryAll, queryOne } from "./db.ts";
import { nowIso } from "./logger.ts";

export interface ChatMessage {
  role: string;
  content: unknown;
  name?: string;
  tool_calls?: unknown;
  tool_call_id?: string;
}

export interface SessionRecord {
  id: string;
  clientId: string | null;
  clientSig: string;
  userAgent: string | null;
  remoteAddr: string | null;
  lastModel: string | null;
  turnCount: number;
}

export interface SessionInput {
  sessionId?: string | null;
  clientId?: string | null;
  userAgent?: string | null;
  remoteAddr?: string | null;
}

function clientSignature(input: SessionInput): string {
  const material = [input.clientId ?? "", input.userAgent ?? "", input.remoteAddr ?? ""].join("|");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

export function resolveSession(input: SessionInput): SessionRecord {
  const signature = clientSignature(input);
  const id = input.sessionId?.trim() || randomUUID();

  const existing = queryOne<{
    id: string;
    client_id: string | null;
    client_sig: string;
    user_agent: string | null;
    remote_addr: string | null;
    last_model: string | null;
    turn_count: number;
  }>("SELECT * FROM sessions WHERE id = ?", id);

  if (existing) {
    execute("UPDATE sessions SET updated_at = ?, user_agent = COALESCE(?, user_agent) WHERE id = ?", nowIso(), input.userAgent ?? null, id);
    return {
      id: existing.id,
      clientId: existing.client_id,
      clientSig: existing.client_sig,
      userAgent: existing.user_agent,
      remoteAddr: existing.remote_addr,
      lastModel: existing.last_model,
      turnCount: existing.turn_count,
    };
  }

  execute(
    `INSERT INTO sessions (id, client_id, client_sig, user_agent, remote_addr, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.clientId ?? null,
    signature,
    input.userAgent ?? null,
    input.remoteAddr ?? null,
    nowIso(),
    nowIso(),
  );

  return {
    id,
    clientId: input.clientId ?? null,
    clientSig: signature,
    userAgent: input.userAgent ?? null,
    remoteAddr: input.remoteAddr ?? null,
    lastModel: null,
    turnCount: 0,
  };
}

export function loadHistory(sessionId: string): ChatMessage[] {
  const rows = queryAll<{
    role: string;
    content: string;
    name: string | null;
    tool_call_id: string | null;
    tool_calls: string | null;
  }>("SELECT role, content, name, tool_call_id, tool_calls FROM messages WHERE session_id = ? ORDER BY id", sessionId);

  return rows.map((row) => {
    const message: ChatMessage = { role: row.role, content: row.content };
    if (row.name) message.name = row.name;
    if (row.tool_call_id) message.tool_call_id = row.tool_call_id;
    if (row.tool_calls) {
      try {
        message.tool_calls = JSON.parse(row.tool_calls);
      } catch {
        message.tool_calls = row.tool_calls;
      }
    }
    return message;
  });
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

export function appendMessages(
  sessionId: string,
  messages: ChatMessage[],
  model: string | null,
): void {
  if (messages.length === 0) return;
  execute("BEGIN");
  try {
    for (const message of messages) {
      execute(
        `INSERT INTO messages (session_id, role, content, name, tool_call_id, tool_calls, model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        sessionId,
        message.role,
        contentToText(message.content),
        message.name ?? null,
        message.tool_call_id ?? null,
        message.tool_calls === undefined ? null : JSON.stringify(message.tool_calls),
        model,
        nowIso(),
      );
    }
    execute(
      "UPDATE sessions SET updated_at = ?, last_model = COALESCE(?, last_model), turn_count = turn_count + ? WHERE id = ?",
      nowIso(),
      model,
      messages.some((message) => message.role === "user") ? 1 : 0,
      sessionId,
    );
    execute("COMMIT");
  } catch (error) {
    execute("ROLLBACK");
    throw error;
  }
}

/**
 * Stores only the messages the client has not sent before.
 *
 * Two client styles are handled by one rule:
 *  - full transcript: the stored history is a prefix of the incoming list, so
 *    only the tail is appended;
 *  - delta only: no prefix relation exists, so everything incoming is appended.
 * An edited transcript therefore duplicates instead of silently dropping turns,
 * which is the safer failure for an audit log.
 */
export function persistNewMessages(
  sessionId: string,
  messages: ChatMessage[],
  model: string | null,
): void {
  if (messages.length === 0) return;

  const stored = queryAll<{ role: string; content: string }>(
    "SELECT role, content FROM messages WHERE session_id = ? ORDER BY id",
    sessionId,
  );

  let consumed = 0;
  if (stored.length > 0 && stored.length <= messages.length) {
    const isPrefix = stored.every((row, index) => {
      const incoming = messages[index];
      if (!incoming) return false;
      return row.role === incoming.role && row.content === contentToText(incoming.content);
    });
    if (isPrefix) consumed = stored.length;
  }

  appendMessages(sessionId, messages.slice(consumed), model);
}

export interface RequestLogRow {
  requestId: string;
  sessionId: string | null;
  clientSig: string | null;
  providerId: string | null;
  modelId: string | null;
  stream: boolean;
  status: number;
  errorCode: string | null;
  upstreamStatus: number | null;
  durationMs: number;
  ttfbMs: number | null;
  chunkCount: number;
  promptBytes: number;
  promptHash: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  detail: string | null;
}

export function recordRequest(row: RequestLogRow): void {
  execute(
    `INSERT INTO request_logs (
       request_id, ts, session_id, client_sig, provider_id, model_id, stream, status,
       error_code, upstream_status, duration_ms, ttfb_ms, chunk_count, prompt_bytes,
       prompt_hash, prompt_tokens, completion_tokens, detail
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.requestId,
    nowIso(),
    row.sessionId,
    row.clientSig,
    row.providerId,
    row.modelId,
    row.stream ? 1 : 0,
    row.status,
    row.errorCode,
    row.upstreamStatus,
    row.durationMs,
    row.ttfbMs,
    row.chunkCount,
    row.promptBytes,
    row.promptHash,
    row.promptTokens,
    row.completionTokens,
    row.detail,
  );
}
