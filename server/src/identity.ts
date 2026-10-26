/**
 * System identity (SSI-Core metadata).
 *
 * The file is read once at boot and never written back: identity is immutable at
 * runtime, and its sha256 is published through /admin/system so tampering is
 * visible instead of invisible.
 *
 * Headers are attribution, not a covert watermark: they are documented in
 * docs/ADMIN-API.md and can be disabled with GATEWAY_IDENTITY_HEADERS=0.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface SystemIdentity {
  name: string;
  version: string;
  tagline: string;
  protocol: string;
  owner: string;
  organization: string;
  location: string;
  website: string | null;
  license: string;
}

export interface LoadedIdentity {
  identity: SystemIdentity;
  source: string;
  sha256: string;
  valid: boolean;
}

const DEFAULT_FILE = fileURLToPath(new URL("../identity.json", import.meta.url));

const FALLBACK: SystemIdentity = {
  name: "Compatible Providers",
  version: "0.0.0",
  tagline: "",
  protocol: "SSI-Core",
  owner: "unknown",
  organization: "unknown",
  location: "unknown",
  website: null,
  license: "unspecified",
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

export function loadIdentity(explicitFile?: string): LoadedIdentity {
  const source = explicitFile && explicitFile.length > 0 ? explicitFile : DEFAULT_FILE;

  let raw: string;
  try {
    raw = readFileSync(source, "utf8");
  } catch {
    return { identity: FALLBACK, source, sha256: "", valid: false };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = asRecord(JSON.parse(raw));
  } catch {
    return { identity: FALLBACK, source, sha256: createHash("sha256").update(raw).digest("hex"), valid: false };
  }

  const root = asRecord(parsed["system_identity"]);
  const branding = asRecord(root["branding"]);
  const contact = asRecord(root["contact"]);

  return {
    identity: {
      name: str(root["name"], FALLBACK.name),
      version: str(root["version"], FALLBACK.version),
      tagline: str(root["tagline"], FALLBACK.tagline),
      protocol: str(root["protocol"], FALLBACK.protocol),
      owner: str(branding["owner"], FALLBACK.owner),
      organization: str(branding["organization"], FALLBACK.organization),
      location: str(branding["location"], FALLBACK.location),
      website: typeof contact["website"] === "string" ? contact["website"] : null,
      license: str(root["license"], FALLBACK.license),
    },
    source,
    sha256: createHash("sha256").update(raw).digest("hex"),
    valid: true,
  };
}

export function identityHeaders(loaded: LoadedIdentity): Record<string, string> {
  const { identity } = loaded;
  return {
    "x-system-identity": identity.name,
    "x-system-version": identity.version,
    "x-system-owner": identity.owner,
    "x-powered-by": `${identity.name}-by-${identity.owner.replace(/\s+/g, "")}`,
  };
}
