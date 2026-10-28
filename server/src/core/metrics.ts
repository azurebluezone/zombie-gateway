/**
 * Realtime admin metrics.
 *
 * Everything is derived from `request_logs` so the numbers cannot drift from the
 * actual request path. Aggregation happens in SQLite, not in the process, and the
 * window is explicit so a dashboard never shows an undefined period.
 */

import { queryAll, queryOne } from "./db.ts";

export interface WindowTotals {
  calls: number;
  errors: number;
  /**
   * Requests the client abandoned (status 499). Kept out of `errors`: a peer
   * closing the tab is not a gateway failure, and folding it in would make the
   * error rate grow with user patience.
   */
  aborted: number;
  avg_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
  avg_ttfb_ms: number | null;
  prompt_tokens: number;
  completion_tokens: number;
}

interface AggregateRow {
  calls: number;
  errors: number | null;
  aborted: number | null;
  avg_ms: number | null;
  max_ms: number | null;
  avg_ttfb_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
}

interface PercentileRow {
  duration_ms: number;
}

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? null;
}

function totalsFor(since: string, providerId?: string, modelId?: string): WindowTotals {
  const filters = ["ts >= ?"];
  const params: string[] = [since];
  if (providerId) {
    filters.push("provider_id = ?");
    params.push(providerId);
  }
  if (modelId) {
    filters.push("model_id = ?");
    params.push(modelId);
  }
  const where = filters.join(" AND ");

  const row = queryOne<AggregateRow>(
    `SELECT COUNT(*) AS calls,
            SUM(CASE WHEN status >= 400 AND status <> 499 THEN 1 ELSE 0 END) AS errors,
            SUM(CASE WHEN status = 499 THEN 1 ELSE 0 END) AS aborted,
            AVG(CASE WHEN status <> 499 THEN duration_ms END) AS avg_ms,
            MAX(CASE WHEN status <> 499 THEN duration_ms END) AS max_ms,
            AVG(CASE WHEN status <> 499 THEN ttfb_ms END) AS avg_ttfb_ms,
            SUM(COALESCE(prompt_tokens, 0)) AS prompt_tokens,
            SUM(COALESCE(completion_tokens, 0)) AS completion_tokens
     FROM request_logs WHERE ${where}`,
    ...params,
  );

  // Same rule as the aggregates: a 499 measures how long the caller waited,
  // not how fast the model answered, so it must not move p95 either.
  const durations = queryAll<PercentileRow>(
    `SELECT duration_ms FROM request_logs WHERE ${where} AND status <> 499 ORDER BY id DESC LIMIT 500`,
    ...params,
  ).map((entry) => entry.duration_ms);

  return {
    calls: row?.calls ?? 0,
    errors: row?.errors ?? 0,
    aborted: row?.aborted ?? 0,
    avg_ms: row?.avg_ms === null || row?.avg_ms === undefined ? null : Math.round(row.avg_ms),
    p95_ms: percentile(durations, 0.95),
    max_ms: row?.max_ms ?? null,
    avg_ttfb_ms:
      row?.avg_ttfb_ms === null || row?.avg_ttfb_ms === undefined ? null : Math.round(row.avg_ttfb_ms),
    prompt_tokens: row?.prompt_tokens ?? 0,
    completion_tokens: row?.completion_tokens ?? 0,
  };
}

export interface ProviderMetric extends WindowTotals {
  provider_id: string;
}

export interface ModelMetric extends WindowTotals {
  provider_id: string;
  model_id: string;
}

export interface MinuteBucket {
  minute: string;
  calls: number;
  errors: number;
  aborted: number;
}

export interface MetricsSnapshot {
  window_ms: number;
  since: string;
  totals: WindowTotals;
  providers: ProviderMetric[];
  models: ModelMetric[];
  buckets: MinuteBucket[];
}

export function collectMetrics(windowMs: number): MetricsSnapshot {
  const clamped = Math.min(Math.max(windowMs, 60_000), 7 * 24 * 60 * 60 * 1000);
  const since = new Date(Date.now() - clamped).toISOString();

  const providerRows = queryAll<{ provider_id: string | null }>(
    `SELECT DISTINCT provider_id FROM request_logs WHERE ts >= ? AND provider_id IS NOT NULL`,
    since,
  );

  const providers: ProviderMetric[] = providerRows
    .map((row) => row.provider_id)
    .filter((id): id is string => typeof id === "string")
    .map((id) => ({ provider_id: id, ...totalsFor(since, id) }));

  const modelRows = queryAll<{ provider_id: string | null; model_id: string | null }>(
    `SELECT DISTINCT provider_id, model_id FROM request_logs
     WHERE ts >= ? AND provider_id IS NOT NULL AND model_id IS NOT NULL`,
    since,
  );

  const models: ModelMetric[] = modelRows
    .filter((row): row is { provider_id: string; model_id: string } =>
      typeof row.provider_id === "string" && typeof row.model_id === "string",
    )
    .map((row) => ({
      provider_id: row.provider_id,
      model_id: row.model_id,
      ...totalsFor(since, row.provider_id, row.model_id),
    }));

  const buckets = queryAll<MinuteBucket>(
    `SELECT substr(ts, 1, 16) AS minute,
            COUNT(*) AS calls,
            SUM(CASE WHEN status >= 400 AND status <> 499 THEN 1 ELSE 0 END) AS errors,
            SUM(CASE WHEN status = 499 THEN 1 ELSE 0 END) AS aborted
     FROM request_logs WHERE ts >= ?
     GROUP BY minute ORDER BY minute DESC LIMIT 60`,
    since,
  );

  return {
    window_ms: clamped,
    since,
    totals: totalsFor(since),
    providers,
    models,
    buckets,
  };
}

export interface RequestRow {
  request_id: string;
  ts: string;
  provider_id: string | null;
  model_id: string | null;
  stream: number;
  status: number;
  error_code: string | null;
  duration_ms: number;
  ttfb_ms: number | null;
  chunk_count: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  session_id: string | null;
}

export function recentRequests(limit: number, providerId?: string): RequestRow[] {
  const capped = Math.min(Math.max(limit, 1), 200);
  if (providerId) {
    return queryAll<RequestRow>(
      `SELECT request_id, ts, provider_id, model_id, stream, status, error_code,
              duration_ms, ttfb_ms, chunk_count, prompt_tokens, completion_tokens, session_id
       FROM request_logs WHERE provider_id = ? ORDER BY id DESC LIMIT ?`,
      providerId,
      capped,
    );
  }
  return queryAll<RequestRow>(
    `SELECT request_id, ts, provider_id, model_id, stream, status, error_code,
            duration_ms, ttfb_ms, chunk_count, prompt_tokens, completion_tokens, session_id
     FROM request_logs ORDER BY id DESC LIMIT ?`,
    capped,
  );
}

export interface ModelRuntimeStat {
  provider_id: string;
  model_id: string;
  calls: number;
  errors: number;
  aborted: number;
  avg_ms: number | null;
  max_ms: number | null;
  prompt_tokens: number;
  completion_tokens: number;
  last_ts: string | null;
}

/**
 * Per-model runtime numbers for the admin panel.
 *
 * Same source as every other metric (request_logs), grouped by the pair that
 * actually answered the request. A model that never served a request in the
 * window has no row here — the caller merges by catalogue id, so "no traffic"
 * stays distinguishable from "zero milliseconds".
 */
export function modelRuntimeStats(windowMs: number): ModelRuntimeStat[] {
  const clamped = Math.min(Math.max(windowMs, 60_000), 7 * 24 * 60 * 60 * 1000);
  const since = new Date(Date.now() - clamped).toISOString();
  return queryAll<ModelRuntimeStat>(
    // 499 means the client hung up; it is not a model error and its wall time
    // measures how long the caller waited, not how fast the model answered.
    // Counting it as an error or folding it into avg/max made one aborted call
    // look like a two-minute model turn.
    `SELECT provider_id,
            model_id,
            COUNT(*) AS calls,
            SUM(CASE WHEN status >= 400 AND status <> 499 THEN 1 ELSE 0 END) AS errors,
            SUM(CASE WHEN status = 499 THEN 1 ELSE 0 END) AS aborted,
            AVG(CASE WHEN status <> 499 THEN duration_ms END) AS avg_ms,
            MAX(CASE WHEN status <> 499 THEN duration_ms END) AS max_ms,
            SUM(COALESCE(prompt_tokens, 0)) AS prompt_tokens,
            SUM(COALESCE(completion_tokens, 0)) AS completion_tokens,
            MAX(ts) AS last_ts
     FROM request_logs
     WHERE ts >= ? AND provider_id IS NOT NULL AND model_id IS NOT NULL
     GROUP BY provider_id, model_id
     ORDER BY calls DESC`,
    since,
  );
}
