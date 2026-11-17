/**
 * Ollama driver.
 *
 * Wire protocol: OpenAI-compatible surface under /v1 for inference, native
 * surface under /api for catalogue truth.
 *
 * Why both: /v1/models returns id/created/owned_by only, while /api/tags
 * returns capabilities, families, quantisation and context_length. Sending a
 * tool request to a model whose capability set lacks "tools" is a guaranteed
 * upstream 400, so the catalogue must come from /api/tags.
 */

import type { ProviderConfig } from "../config.ts";
import type { DiscoveredModel, DiscoverContext, ProviderDriver } from "./types.ts";
import { asArray, asNumber, asRecord, asString, publicModelId, uniq } from "./types.ts";
import { probeJson } from "../transport/request.ts";

interface TagEntry {
  name?: unknown;
  model?: unknown;
  size?: unknown;
  details?: unknown;
  capabilities?: unknown;
}

function fromTags(config: ProviderConfig, payload: unknown): DiscoveredModel[] {
  const root = asRecord(payload);
  const entries = asArray(root?.["models"]) as TagEntry[];
  const models: DiscoveredModel[] = [];

  for (const entry of entries) {
    const upstreamId = asString(entry.model) ?? asString(entry.name);
    if (!upstreamId) continue;
    const details = asRecord(entry.details);
    models.push({
      providerId: config.id,
      modelId: publicModelId(upstreamId),
      upstreamId,
      displayName: asString(entry.name) ?? upstreamId,
      caps: uniq(
        asArray(entry.capabilities)
          .map((cap) => asString(cap))
          .filter((cap): cap is string => cap !== null),
      ),
      contextLength: asNumber(details?.["context_length"]),
      parameterSize: asString(details?.["parameter_size"]),
      quantization: asString(details?.["quantization_level"]),
      family: asString(details?.["family"]),
      sizeBytes: asNumber(entry.size),
      source: "ollama:/api/tags",
      raw: entry,
    });
  }
  return models;
}

function fromOpenAiList(config: ProviderConfig, payload: unknown, declared: string[]): DiscoveredModel[] {
  const root = asRecord(payload);
  const entries = asArray(root?.["data"]);
  const seen = new Set<string>();
  const models: DiscoveredModel[] = [];

  for (const entry of entries) {
    const record = asRecord(entry);
    const upstreamId = asString(record?.["id"]);
    if (!upstreamId || seen.has(upstreamId)) continue;
    seen.add(upstreamId);
    models.push({
      providerId: config.id,
      modelId: publicModelId(upstreamId),
      upstreamId,
      displayName: upstreamId,
      caps: [...declared],
      contextLength: null,
      parameterSize: null,
      quantization: null,
      family: null,
      sizeBytes: null,
      source: "ollama:/v1/models",
      raw: entry,
    });
  }

  // Declared models survive a cold server: the catalogue stays usable for
  // clients that only need routing metadata while the model is unloaded.
  for (const declaredId of declared) {
    if (seen.has(declaredId)) continue;
    models.push({
      providerId: config.id,
      modelId: publicModelId(declaredId),
      upstreamId: declaredId,
      displayName: declaredId,
      caps: [...declared],
      contextLength: null,
      parameterSize: null,
      quantization: null,
      family: null,
      sizeBytes: null,
      source: "config:models",
      raw: null,
    });
  }

  return models;
}

export const ollamaDriver: ProviderDriver = {
  kind: "ollama",
  chatPath: "/v1/chat/completions",
  embeddingsPath: "/v1/embeddings",

  async discover(config: ProviderConfig, context: DiscoverContext): Promise<DiscoveredModel[]> {
    const native = await probeJson(config, "/api/tags");
    if (native.status === 200) {
      const models = fromTags(config, native.json);
      if (models.length > 0) return decorate(config, models, context.declaredCaps);
    }

    const compat = await probeJson(config, "/v1/models");
    if (compat.status === 200) {
      return decorate(config, fromOpenAiList(config, compat.json, context.declaredModels), context.declaredCaps);
    }

    throw new Error(`Ollama catalogue unreachable (tags=${native.status}, v1=${compat.status})`);
  },
};

/** Declared capabilities are additive only: discovery wins on conflicts. */
function decorate(
  _config: ProviderConfig,
  models: DiscoveredModel[],
  declaredCaps: string[],
): DiscoveredModel[] {
  if (declaredCaps.length === 0) return models;
  return models.map((model) => ({ ...model, caps: uniq([...model.caps, ...declaredCaps]) }));
}
