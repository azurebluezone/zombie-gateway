/**
 * Generic custom provider driver.
 *
 * Contract: any endpoint that speaks the OpenAI chat-completions schema.
 * Nothing is assumed beyond /v1/models and /v1/chat/completions, because the
 * "custom" bucket is where undocumented gateways end up. Capabilities are
 * declared in env, never guessed.
 */

import type { ProviderConfig } from "../config.ts";
import type { DiscoveredModel, DiscoverContext, ProviderDriver } from "./types.ts";
import { asArray, asNumber, asRecord, asString, publicModelId, uniq } from "./types.ts";
import { probeJson } from "../transport/request.ts";

export const openAiCompatibleDriver: ProviderDriver = {
  kind: "openai",
  // Paths are relative to base_url, which for the custom bucket already ends in
  // the version segment (for example https://host/api/v1). Concatenating another
  // /v1 here would produce /v1/v1/models.
  chatPath: "/chat/completions",
  embeddingsPath: "/embeddings",

  async discover(config: ProviderConfig, context: DiscoverContext): Promise<DiscoveredModel[]> {
    const result = await probeJson(config, "/models");
    const models: DiscoveredModel[] = [];

    if (result.status === 200) {
      const root = asRecord(result.json);
      // Everything this endpoint lists is, by contract, a chat-completions
      // model; saying otherwise would understate the catalogue it just returned.
      const caps = uniq(["completion", ...context.declaredCaps]);
      for (const entry of asArray(root?.["data"])) {
        const record = asRecord(entry);
        const upstreamId = asString(record?.["id"]);
        if (!upstreamId) continue;
        models.push({
          providerId: config.id,
          modelId: publicModelId(upstreamId),
          upstreamId,
          displayName: asString(record?.["name"]) ?? upstreamId,
          caps,
          contextLength: asNumber(record?.["context_length"]),
          parameterSize: null,
          quantization: null,
          family: asString(record?.["owned_by"]),
          sizeBytes: null,
          source: "custom:/v1/models",
          raw: entry,
        });
      }
    }

    for (const declaredId of context.declaredModels) {
      if (models.some((model) => model.upstreamId === declaredId)) continue;
      models.push({
        providerId: config.id,
        modelId: publicModelId(declaredId),
        upstreamId: declaredId,
        displayName: declaredId,
        caps: uniq(["completion", ...context.declaredCaps]),
        contextLength: null,
        parameterSize: null,
        quantization: null,
        family: null,
        sizeBytes: null,
        source: "config:models",
        raw: null,
      });
    }

    if (models.length === 0 && result.status >= 400) {
      throw new Error(`Custom provider /v1/models returned ${result.status} and no models are declared`);
    }
    return models;
  },
};
