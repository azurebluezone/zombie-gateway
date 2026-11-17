/**
 * OpenCode server driver.
 *
 * OpenCode runs a local HTTP server that already normalises many upstream
 * providers. Its model catalogue lives at /config/providers and carries real
 * capability flags (toolcall, reasoning, attachment) plus context limits, which
 * is strictly richer than an OpenAI /v1/models list.
 *
 * Inference still goes through the OpenAI-compatible surface, so a client that
 * only understands OpenAI sees nothing unusual.
 */

import type { ProviderConfig } from "../config.ts";
import type { DiscoveredModel, DiscoverContext, ProviderDriver } from "./types.ts";
import { asArray, asNumber, asRecord, asString, publicModelId, uniq } from "./types.ts";
import { probeJson } from "../transport/request.ts";

function capsFromModel(record: Record<string, unknown> | null): string[] {
  const caps = asRecord(record?.["capabilities"]);
  const out: string[] = ["completion"];
  if (caps?.["toolcall"] === true) out.push("tools");
  if (caps?.["reasoning"] === true) out.push("thinking");
  const input = asRecord(caps?.["input"]);
  if (input?.["image"] === true) out.push("vision");
  if (input?.["audio"] === true) out.push("audio");
  if (input?.["pdf"] === true) out.push("pdf");
  return uniq(out);
}

export const openCodeDriver: ProviderDriver = {
  kind: "opencode",
  chatPath: "/v1/chat/completions",
  embeddingsPath: "/v1/embeddings",

  async discover(config: ProviderConfig, context: DiscoverContext): Promise<DiscoveredModel[]> {
    const models: DiscoveredModel[] = [];
    const result = await probeJson(config, "/config/providers");

    if (result.status === 200) {
      const root = asRecord(result.json);
      for (const providerEntry of asArray(root?.["providers"])) {
        const provider = asRecord(providerEntry);
        const providerKey = asString(provider?.["id"]);
        const catalogue = asRecord(provider?.["models"]);
        if (!catalogue) continue;

        for (const [key, value] of Object.entries(catalogue)) {
          const model = asRecord(value);
          const upstreamId = `${providerKey ?? "opencode"}/${asString(model?.["id"]) ?? key}`;
          const limit = asRecord(model?.["limit"]);
          models.push({
            providerId: config.id,
            modelId: publicModelId(upstreamId),
            upstreamId,
            displayName: asString(model?.["name"]) ?? key,
            caps: uniq([...capsFromModel(model), ...context.declaredCaps]),
            contextLength: asNumber(limit?.["context"]),
            parameterSize: null,
            quantization: null,
            family: providerKey,
            sizeBytes: null,
            source: "opencode:/config/providers",
            raw: value,
          });
        }
      }
    }

    if (models.length === 0) {
      const compat = await probeJson(config, "/v1/models");
      if (compat.status === 200) {
        const root = asRecord(compat.json);
        for (const entry of asArray(root?.["data"])) {
          const record = asRecord(entry);
          const upstreamId = asString(record?.["id"]);
          if (!upstreamId) continue;
          models.push({
            providerId: config.id,
            modelId: publicModelId(upstreamId),
            upstreamId,
            displayName: upstreamId,
            caps: uniq(["completion", ...context.declaredCaps]),
            contextLength: null,
            parameterSize: null,
            quantization: null,
            family: null,
            sizeBytes: null,
            source: "opencode:/v1/models",
            raw: entry,
          });
        }
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

    return models;
  },
};
