/**
 * Model catalogue.
 *
 * The catalogue is the single source of routing truth. It is rebuilt from each
 * provider's own discovery endpoint, but a failed probe never deletes rows: a
 * local engine that is simply switched off must not erase the model list.
 *
 * Deletion policy: a row leaves the catalogue only after MISSING_SCANS_LIMIT
 * consecutive *successful* scans that did not mention it.
 */

import { createHash } from "node:crypto";
import type { ProviderConfig } from "../config.ts";
import { execute, queryAll, queryOne } from "./db.ts";
import { nowIso } from "./logger.ts";
import { GatewayError } from "./errors.ts";
import { driverFor, type DiscoveredModel } from "../providers/index.ts";

const MISSING_SCANS_LIMIT = 3;

export interface SyncReport {
  providerId: string;
  ok: boolean;
  models: number;
  durationMs: number;
  error: string | null;
}

export interface PublicModel {
  providerId: string;
  modelId: string;
  fullId: string;
  upstreamId: string;
  displayName: string;
  caps: string[];
  contextLength: number | null;
  parameterSize: string | null;
  quantization: string | null;
  family: string | null;
  sizeBytes: number | null;
  source: string;
  lastSeenAt: string;
}

export interface ResolvedModel {
  providerId: string;
  modelId: string;
  upstreamId: string;
  caps: string[];
  contextLength: number | null;
}

export function fullModelId(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

export function hashPrompt(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function upsertProvider(config: ProviderConfig, discoveredCaps: string[], error: string | null): void {
  execute(
    `INSERT INTO providers (id, kind, base_url, transport, socket_path, api_key_ref, declared_caps, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       kind = excluded.kind,
       base_url = excluded.base_url,
       transport = excluded.transport,
       socket_path = excluded.socket_path,
       api_key_ref = excluded.api_key_ref,
       declared_caps = excluded.declared_caps`,
    config.id,
    config.kind,
    config.baseUrl,
    config.transport,
    config.socketPath,
    config.apiKey ? "env" : null,
    JSON.stringify(config.caps),
    nowIso(),
  );

  execute(
    `UPDATE providers SET discovered_caps = ?, last_probe_at = ?, last_error = ? WHERE id = ?`,
    JSON.stringify(discoveredCaps),
    nowIso(),
    error,
    config.id,
  );
}

function upsertModel(model: DiscoveredModel): void {
  execute(
    `INSERT INTO models (
       provider_id, model_id, upstream_id, display_name, caps, context_length,
       parameter_size, quantization, family, size_bytes, source, capabilities_source,
       first_seen_at, last_seen_at, missing_scans, active, raw
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?)
     ON CONFLICT(provider_id, model_id) DO UPDATE SET
       upstream_id = excluded.upstream_id,
       display_name = excluded.display_name,
       caps = excluded.caps,
       context_length = excluded.context_length,
       parameter_size = excluded.parameter_size,
       quantization = excluded.quantization,
       family = excluded.family,
       size_bytes = excluded.size_bytes,
       source = excluded.source,
       capabilities_source = excluded.capabilities_source,
       last_seen_at = excluded.last_seen_at,
       missing_scans = 0,
       active = 1,
       raw = excluded.raw`,
    model.providerId,
    model.modelId,
    model.upstreamId,
    model.displayName,
    JSON.stringify(model.caps),
    model.contextLength,
    model.parameterSize,
    model.quantization,
    model.family,
    model.sizeBytes,
    model.source,
    model.source,
    nowIso(),
    nowIso(),
    model.raw === null ? null : JSON.stringify(model.raw),
  );
}

export async function syncProvider(config: ProviderConfig): Promise<SyncReport> {
  const startedAt = Date.now();
  const scanStartedAt = nowIso();
  const driver = driverFor(config.kind);

  try {
    const discovered = await driver.discover(config, {
      declaredCaps: config.caps,
      declaredModels: config.models,
    });

    const capabilities = [...new Set(discovered.flatMap((model) => model.caps))];
    upsertProvider(config, capabilities, null);

    execute("BEGIN");
    try {
      for (const model of discovered) upsertModel(model);

      // Only a successful scan is allowed to age out rows.
      execute(
        `UPDATE models SET missing_scans = missing_scans + 1
         WHERE provider_id = ? AND last_seen_at < ?`,
        config.id,
        scanStartedAt,
      );
      execute(
        `UPDATE models SET active = 0
         WHERE provider_id = ? AND active = 1 AND missing_scans >= ?`,
        config.id,
        MISSING_SCANS_LIMIT,
      );
      execute("COMMIT");
    } catch (error) {
      execute("ROLLBACK");
      throw error;
    }

    return {
      providerId: config.id,
      ok: true,
      models: discovered.length,
      durationMs: Date.now() - startedAt,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const previous = queryOne<{ discovered_caps: string }>(
      "SELECT discovered_caps FROM providers WHERE id = ?",
      config.id,
    );
    upsertProvider(config, previous ? (JSON.parse(previous.discovered_caps) as string[]) : [], message);

    return {
      providerId: config.id,
      ok: false,
      models: 0,
      durationMs: Date.now() - startedAt,
      error: message,
    };
  }
}

export async function syncAll(configs: ProviderConfig[]): Promise<SyncReport[]> {
  const reports: SyncReport[] = [];
  for (const config of configs) {
    reports.push(await syncProvider(config));
  }
  return reports;
}

interface ModelRow {
  provider_id: string;
  model_id: string;
  upstream_id: string;
  display_name: string | null;
  caps: string;
  context_length: number | null;
  parameter_size: string | null;
  quantization: string | null;
  family: string | null;
  size_bytes: number | null;
  source: string;
  last_seen_at: string;
}

function parseCaps(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function listPublicModels(providerId?: string, includeDisabled = false): PublicModel[] {
  const gate = includeDisabled ? "" : " AND p.enabled = 1";
  const rows = providerId
    ? queryAll<ModelRow>(
        `SELECT m.* FROM models m JOIN providers p ON p.id = m.provider_id
         WHERE m.active = 1${gate} AND m.provider_id = ? ORDER BY m.provider_id, m.model_id`,
        providerId,
      )
    : queryAll<ModelRow>(
        `SELECT m.* FROM models m JOIN providers p ON p.id = m.provider_id
         WHERE m.active = 1${gate} ORDER BY m.provider_id, m.model_id`,
      );

  return rows.map((row) => ({
    providerId: row.provider_id,
    modelId: row.model_id,
    fullId: fullModelId(row.provider_id, row.model_id),
    upstreamId: row.upstream_id,
    displayName: row.display_name ?? row.upstream_id,
    caps: parseCaps(row.caps),
    contextLength: row.context_length,
    parameterSize: row.parameter_size,
    quantization: row.quantization,
    family: row.family,
    sizeBytes: row.size_bytes,
    source: row.source,
    lastSeenAt: row.last_seen_at,
  }));
}

export function resolveModel(reference: string): ResolvedModel {
  const normalized = reference.trim();
  if (!normalized) {
    throw new GatewayError({
      message: "Field 'model' is required",
      status: 400,
      code: "invalid_request_error",
      param: "model",
    });
  }

  const exact = queryOne<ModelRow>(
    `SELECT m.* FROM models m JOIN providers p ON p.id = m.provider_id
     WHERE m.active = 1 AND p.enabled = 1 AND m.provider_id || '/' || m.model_id = ?`,
    normalized.toLowerCase(),
  );
  if (exact) return toResolved(exact);

  const candidates = queryAll<ModelRow>(
    `SELECT m.* FROM models m JOIN providers p ON p.id = m.provider_id
     WHERE m.active = 1 AND p.enabled = 1 AND m.model_id = ?`,
    normalized.toLowerCase(),
  );
  if (candidates.length === 1) {
    const only = candidates[0];
    if (only) return toResolved(only);
  }
  if (candidates.length > 1) {
    const options = candidates.map((row) => fullModelId(row.provider_id, row.model_id)).join(", ");
    throw new GatewayError({
      message: `Model "${reference}" exists on multiple providers; use a qualified id: ${options}`,
      status: 400,
      code: "invalid_request_error",
      param: "model",
    });
  }

  throw new GatewayError({
    message: `Model "${reference}" is not in the catalogue. Run a sync or check GET /v1/models.`,
    status: 404,
    code: "model_not_found",
    param: "model",
  });
}

function toResolved(row: ModelRow): ResolvedModel {
  return {
    providerId: row.provider_id,
    modelId: row.model_id,
    upstreamId: row.upstream_id,
    caps: parseCaps(row.caps),
    contextLength: row.context_length,
  };
}
