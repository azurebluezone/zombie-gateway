import type { ProviderConfig, ProviderKind } from "../config.ts";

export interface DiscoveredModel {
  providerId: string;
  /** Public id, used by clients and by the SQLite key. */
  modelId: string;
  /** Exact id sent upstream. Never rewritten. */
  upstreamId: string;
  displayName: string | null;
  caps: string[];
  contextLength: number | null;
  parameterSize: string | null;
  quantization: string | null;
  family: string | null;
  sizeBytes: number | null;
  source: string;
  raw: unknown;
}

export interface DiscoverContext {
  declaredCaps: string[];
  declaredModels: string[];
}

export interface ProviderDriver {
  readonly kind: ProviderKind;
  readonly chatPath: string;
  readonly embeddingsPath: string;
  discover(config: ProviderConfig, context: DiscoverContext): Promise<DiscoveredModel[]>;
}

export function publicModelId(upstreamId: string): string {
  return upstreamId.trim().toLowerCase();
}

export function uniq(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
