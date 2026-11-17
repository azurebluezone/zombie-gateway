/**
 * llama.cpp driver (llama-server over HTTP/1.1 or a unix socket).
 *
 * Wire protocol: OpenAI-compatible /v1 surface. This is not the in-process
 * ai-sdk-llama-cpp binding, which is macOS-only and has no tool calling.
 *
 * Facts that drive the code:
 *  - /v1/models exposes the loaded model(s) only; a router build can expose more.
 *  - /props carries model_path and the effective n_ctx.
 *  - tool calls require a tool-capable jinja chat template. The server does not
 *    advertise that reliably, so capabilities are declared in env and only
 *    verified lazily when the upstream rejects a tool request.
 *  - /health reports readiness; during a cold model load it is unavailable.
 */

import type { ProviderConfig } from "../config.ts";
import type { DiscoveredModel, DiscoverContext, ProviderDriver } from "./types.ts";
import { asArray, asNumber, asRecord, asString, publicModelId, uniq } from "./types.ts";
import { probeJson } from "../transport/request.ts";

function readPropsContext(payload: unknown): number | null {
  const root = asRecord(payload);
  if (!root) return null;
  const settings = asRecord(root["default_generation_settings"]);
  return (
    asNumber(settings?.["n_ctx"]) ??
    asNumber(root["n_ctx"]) ??
    asNumber(root["context_length"])
  );
}

/**
 * llama-server reports the loaded model as an absolute filesystem path. The
 * public id must not leak where the file lives (or which drive it sits on), and
 * a path is not stable across machines, so only the basename is exposed. The
 * upstream id keeps the full path because that is what the server compares.
 */
function modelNameFromPath(id: string): string {
  const parts = id.split(/[\\/]/);
  return parts[parts.length - 1] ?? id;
}

function readModelPath(payload: unknown): string | null {
  const root = asRecord(payload);
  if (!root) return null;
  const path = asString(root["model_path"]);
  if (!path) return null;
  return modelNameFromPath(path);
}

function fromList(
  config: ProviderConfig,
  payload: unknown,
  contextLength: number | null,
  declaredCaps: string[],
): DiscoveredModel[] {
  const root = asRecord(payload);
  const entries = asArray(root?.["data"]);
  const models: DiscoveredModel[] = [];

  for (const entry of entries) {
    const record = asRecord(entry);
    const upstreamId = asString(record?.["id"]);
    if (!upstreamId) continue;
    const caps = ["completion", ...declaredCaps];
    if (record?.["multimodal"] === true) caps.push("vision");
    // A path-shaped id would leak the filesystem into every client.
    const publicName = modelNameFromPath(upstreamId);
    models.push({
      providerId: config.id,
      modelId: publicModelId(publicName),
      upstreamId,
      displayName: publicName,
      caps: uniq(caps),
      contextLength: asNumber(record?.["context_length"]) ?? contextLength,
      parameterSize: asString(record?.["parameter_size"]),
      quantization: asString(record?.["quantization"]),
      family: asString(record?.["architecture"]),
      sizeBytes: null,
      source: "llamacpp:/v1/models",
      raw: entry,
    });
  }
  return models;
}

export const llamaCppDriver: ProviderDriver = {
  kind: "llamacpp",
  chatPath: "/v1/chat/completions",
  embeddingsPath: "/v1/embeddings",

  async discover(config: ProviderConfig, context: DiscoverContext): Promise<DiscoveredModel[]> {
    const props = await probeJson(config, "/props");
    const contextLength = props.status === 200 ? readPropsContext(props.json) : null;

    const list = await probeJson(config, "/v1/models");
    let models: DiscoveredModel[] = [];
    if (list.status === 200) {
      models = fromList(config, list.json, contextLength, context.declaredCaps);
    }

    // Older builds answered /v1/models with an empty list but always had /props.
    if (models.length === 0 && props.status === 200) {
      const upstreamId = readModelPath(props.json) ?? "default";
      models = [
        {
          providerId: config.id,
          modelId: publicModelId(upstreamId),
          upstreamId,
          displayName: upstreamId,
          caps: uniq(["completion", ...context.declaredCaps]),
          contextLength,
          parameterSize: null,
          quantization: null,
          family: null,
          sizeBytes: null,
          source: "llamacpp:/props",
          raw: props.json,
        },
      ];
    }

    for (const declaredId of context.declaredModels) {
      if (models.some((model) => model.upstreamId === declaredId)) continue;
      models.push({
        providerId: config.id,
        modelId: publicModelId(declaredId),
        upstreamId: declaredId,
        displayName: declaredId,
        caps: uniq(["completion", ...context.declaredCaps]),
        contextLength,
        parameterSize: null,
        quantization: null,
        family: null,
        sizeBytes: null,
        source: "config:models",
        raw: null,
      });
    }

    if (models.length === 0) {
      throw new Error(`llama.cpp catalogue empty (props=${props.status}, v1=${list.status})`);
    }
    return models;
  },
};
