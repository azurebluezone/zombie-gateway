export interface McpHttpResult {
  status: number;
  request_id: string | null;
  body: unknown;
}

export type McpHttp = (
  path: string,
  init?: { method?: string; body?: string; headers?: Record<string, string> },
) => Promise<McpHttpResult>;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export declare const SERVER_INFO: { name: string; version: string };
export declare const FALLBACK_PROTOCOL: string;
export declare function toolResult(
  value: unknown,
  isError?: boolean,
): { content: Array<{ type: "text"; text: string }>; isError: boolean };
export declare function createTools(http: McpHttp): McpTool[];
export declare const TOOL_NAMES: string[];
