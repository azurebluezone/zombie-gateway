/**
 * Machine-readable provider form.
 *
 * This is the "form" the user asked for, expressed as data instead of HTML: any
 * terminal client or admin UI can render it without knowing the field list, and
 * adding a field here requires no schema change in SQLite (it lands in config_json).
 */

export interface FieldSpec {
  name: string;
  type: "string" | "url" | "enum" | "integer" | "boolean" | "object" | "string[]" | "env-name";
  required: boolean;
  default?: unknown;
  values?: string[];
  pattern?: string;
  min?: number;
  hint: string;
  example?: unknown;
}

export const PROVIDER_FIELDS: FieldSpec[] = [
  {
    name: "id",
    type: "string",
    required: false,
    pattern: "^[a-z0-9][a-z0-9-]*$",
    hint: "Stable namespace for model ids. Derived from kind+host+port when omitted.",
    example: "ollama-v1",
  },
  {
    name: "kind",
    type: "enum",
    required: true,
    values: ["ollama", "llamacpp", "openai", "opencode"],
    hint: "Wire dialect. 'openai' is the custom provider bucket: strict /v1/models + /v1/chat/completions.",
    example: "openai",
  },
  {
    name: "base_url",
    type: "url",
    required: true,
    hint: "Root of the API. For an OpenAI-compatible custom provider this usually ends in /v1.",
    example: "http://127.0.0.1:11434/v1",
  },
  {
    name: "transport",
    type: "enum",
    required: false,
    values: ["http", "https", "uds"],
    default: "http",
    hint: "Byte path to the engine. UDS avoids the TCP stack; it is a security/ops choice, not a speed one.",
  },
  {
    name: "socket_path",
    type: "string",
    required: false,
    hint: "Required when transport=uds. Filesystem permissions become the access control.",
    example: "/run/llama.sock",
  },
  {
    name: "api_key_env",
    type: "env-name",
    required: false,
    pattern: "^[A-Z][A-Z0-9_]*$",
    hint: "Name of the environment variable holding the secret. The secret itself is never stored.",
    example: "OPENROUTER_API_KEY",
  },
  {
    name: "headers",
    type: "object",
    required: false,
    default: {},
    hint: "Extra upstream headers stored as JSON (string values only).",
  },
  {
    name: "models",
    type: "string[]",
    required: false,
    default: [],
    hint: "Declared models for providers whose /v1/models is empty or lies.",
  },
  {
    name: "caps",
    type: "string[]",
    required: false,
    default: [],
    hint: "Declared capabilities: completion, tools, thinking, embeddings, vision.",
  },
  {
    name: "timeout_ms",
    type: "integer",
    required: false,
    default: 300000,
    min: 1000,
    hint: "Socket inactivity timeout for this provider.",
  },
  {
    name: "enabled",
    type: "boolean",
    required: false,
    default: true,
    hint: "Disabled providers keep their rows and models but disappear from /v1/models.",
  },
  {
    name: "notes",
    type: "string",
    required: false,
    hint: "Human note stored with the provider.",
  },
  {
    name: "extra",
    type: "object",
    required: false,
    default: {},
    hint: "Arbitrary provider metadata. Stored verbatim in config_json; no column is ever added for it.",
  },
];

export const PROVIDER_EXAMPLES: Record<string, { description: string; body: Record<string, unknown> }> = {
  "ollama-native": {
    description: "Ollama native API on TCP",
    body: { id: "ollama", kind: "ollama", base_url: "http://127.0.0.1:11434" },
  },
  "ollama-as-custom-v1": {
    description: "Same Ollama server registered through its OpenAI-compatible /v1 surface",
    body: {
      id: "ollama-v1",
      kind: "openai",
      base_url: "http://127.0.0.1:11434/v1",
      caps: ["completion", "tools"],
      extra: { role: "test-mirror", upstream: "ollama" },
    },
  },
  "llamacpp-uds": {
    description: "llama-server over a unix socket",
    body: {
      id: "llamacpp",
      kind: "llamacpp",
      base_url: "http://localhost",
      transport: "uds",
      socket_path: "/run/llama.sock",
      caps: ["completion"],
    },
  },
  "custom-openai": {
    description: "Any industry-standard OpenAI-compatible gateway",
    body: {
      id: "openrouter",
      kind: "openai",
      base_url: "https://openrouter.ai/api/v1",
      transport: "https",
      api_key_env: "OPENROUTER_API_KEY",
      headers: { "http-referer": "http://localhost" },
      caps: ["completion", "tools"],
      extra: { tier: "remote", billing: "per-token" },
    },
  },
};

export interface ProviderSchema {
  object: "provider.schema";
  version: number;
  fields: FieldSpec[];
  examples: Record<string, { description: string; body: Record<string, unknown> }>;
  contract: string[];
}

export function providerSchema(): ProviderSchema {
  return {
    object: "provider.schema",
    version: 1,
    fields: PROVIDER_FIELDS,
    examples: PROVIDER_EXAMPLES,
    contract: [
      "Only base_url, kind and the transport triple are interpreted by the gateway.",
      "Everything else is stored in providers.config_json, so a new provider field never needs a migration.",
      "base_url for kind=openai must include the version segment (…/v1): paths are appended as /models and /chat/completions.",
      "base_url for kind=ollama is the server root: paths are /api/tags and /v1/chat/completions.",
      "api_key_env carries an environment variable NAME; the secret value is never written to SQLite.",
    ],
  };
}
