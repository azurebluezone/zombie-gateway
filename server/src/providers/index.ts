import type { ProviderKind } from "../config.ts";
import type { ProviderDriver } from "./types.ts";
import { ollamaDriver } from "./ollama.ts";
import { llamaCppDriver } from "./llamacpp.ts";
import { openAiCompatibleDriver } from "./openai.ts";
import { openCodeDriver } from "./opencode.ts";

const DRIVERS = new Map<ProviderKind, ProviderDriver>([
  ["ollama", ollamaDriver],
  ["llamacpp", llamaCppDriver],
  ["openai", openAiCompatibleDriver],
  ["opencode", openCodeDriver],
]);

export function driverFor(kind: ProviderKind): ProviderDriver {
  const driver = DRIVERS.get(kind);
  if (!driver) throw new Error(`No driver registered for provider kind "${kind}"`);
  return driver;
}

export type { DiscoveredModel, DiscoverContext, ProviderDriver } from "./types.ts";
