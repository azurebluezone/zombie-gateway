/**
 * Client-facing MCP usage page.
 *
 * Two read-only views over the same data:
 *  - GET /client      — server-rendered HTML, auto-refreshed every 5s.
 *  - GET /client.json — the same rows for scripts and tests.
 *
 * Data comes from two places on purpose:
 *  - the in-process session registry (who is connected right now, per-session
 *    tool counts, transport and protocol);
 *  - mcp_call_logs (history that survives a session ending).
 *
 * Session ids are bearer values for the MCP transport, so this page only ever
 * prints an 8-character prefix. Clients are identified by the name/version they
 * sent in `initialize`, which is self-declared and shown as such.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AppContext } from "../core/chat.ts";
import { queryAll, queryOne } from "../core/db.ts";
import { snapshotMcpSessions, type McpSessionView } from "../mcp/http.ts";
import { TOOL_NAMES } from "../../scripts/mcp-tools.mjs";

interface Totals {
  calls: number;
  failed: number;
}

interface ToolRow {
  tool_name: string;
  calls: number;
  failed: number;
  last_call: string | null;
  clients: number;
}

interface ClientToolRow {
  client: string;
  version: string;
  session_id: string | null;
  tool_name: string;
  calls: number;
  failed: number;
  last_call: string | null;
}

interface RecentRow {
  tool_name: string;
  status: string;
  duration_ms: number;
  ts: string;
  session_id: string | null;
  client_name: string | null;
  client_version: string | null;
}

interface ToolUse {
  name: string;
  calls: number;
  failed: number;
  last_seen: string;
}

interface ClientUsage {
  client: { name: string; version: string } | null;
  /** 8-character prefix; the full id never leaves the server. */
  session: string | null;
  live: boolean;
  transport: string | null;
  protocol: string | null;
  requests: number | null;
  last_method: string | null;
  last_seen: string | null;
  calls: number;
  failed: number;
  tools_used: ToolUse[];
}

function shortId(id: string | null): string | null {
  if (!id) return null;
  return id.slice(0, 8);
}

function toolTotals(): Totals {
  const row = queryOne<{ calls: number; failed: number }>(
    `SELECT COUNT(*) calls,
            COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) failed
       FROM mcp_call_logs`,
  );
  return { calls: row?.calls ?? 0, failed: row?.failed ?? 0 };
}

function toolRows(): ToolRow[] {
  const rows = queryAll<ToolRow>(
    `SELECT tool_name,
            COUNT(*) calls,
            COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) failed,
            MAX(ts) last_call,
            COUNT(DISTINCT COALESCE(NULLIF(client_name, ''), 'unknown')) clients
       FROM mcp_call_logs
      GROUP BY tool_name`,
  );
  const counted = new Map(rows.map((row) => [row.tool_name, row]));
  return [
    ...TOOL_NAMES.map(
      (name) => counted.get(name) ?? { tool_name: name, calls: 0, failed: 0, last_call: null, clients: 0 },
    ),
    ...rows.filter((row) => !TOOL_NAMES.includes(row.tool_name)),
  ];
}

function clientRows(): ClientToolRow[] {
  return queryAll<ClientToolRow>(
    `SELECT COALESCE(NULLIF(client_name, ''), 'unknown') client,
            COALESCE(client_version, '') version,
            session_id,
            tool_name,
            COUNT(*) calls,
            COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) failed,
            MAX(ts) last_call
       FROM mcp_call_logs
      GROUP BY client, version, session_id, tool_name
      ORDER BY calls DESC`,
  );
}

function recentRows(): RecentRow[] {
  return queryAll<RecentRow>(
    `SELECT tool_name, status, duration_ms, ts, session_id, client_name, client_version
       FROM mcp_call_logs
      ORDER BY id DESC
      LIMIT 50`,
  );
}

function keyOf(name: string, version: string): string {
  return `${name}\u0000${version}`;
}

function buildClients(sessions: McpSessionView[], rows: ClientToolRow[]): ClientUsage[] {
  const byKey = new Map<string, ClientUsage>();
  const liveIds = new Set(sessions.map((session) => session.id));

  const ensure = (name: string, version: string): ClientUsage => {
    const key = keyOf(name, version);
    let entry = byKey.get(key);
    if (!entry) {
      entry = {
        client: name === "unknown" ? null : { name, version: version || "unknown" },
        session: null,
        live: false,
        transport: null,
        protocol: null,
        requests: null,
        last_method: null,
        last_seen: null,
        calls: 0,
        failed: 0,
        tools_used: [],
      };
      byKey.set(key, entry);
    }
    return entry;
  };

  for (const row of rows) {
    // A live session's calls are already in the registry; adding the DB copy
    // would count every call twice. History from ended sessions still counts.
    if (row.session_id !== null && liveIds.has(row.session_id)) continue;
    const entry = ensure(row.client, row.version);
    entry.calls += row.calls;
    entry.failed += row.failed;
    const tool = entry.tools_used.find((use) => use.name === row.tool_name);
    if (tool) {
      tool.calls += row.calls;
      tool.failed += row.failed;
      if (row.last_call && (!tool.last_seen || row.last_call > tool.last_seen)) tool.last_seen = row.last_call;
    } else {
      entry.tools_used.push({
        name: row.tool_name,
        calls: row.calls,
        failed: row.failed,
        last_seen: row.last_call ?? "",
      });
    }
  }

  for (const session of sessions) {
    const name = session.client?.name ?? "unknown";
    const version = session.client?.version ?? "";
    const entry = ensure(name, version === "unknown" ? "" : version);
    entry.live = true;
    entry.session = shortId(session.id);
    entry.transport = session.transport;
    entry.protocol = session.protocol;
    entry.requests = session.requests;
    entry.last_method = session.last_method;
    entry.last_seen = session.last_seen;
    for (const use of session.tools_used) {
      entry.calls += use.calls;
      entry.failed += use.failed;
      const existing = entry.tools_used.find((tool) => tool.name === use.name);
      if (existing) {
        existing.calls += use.calls;
        existing.failed += use.failed;
        if (use.last_seen > existing.last_seen) existing.last_seen = use.last_seen;
      } else {
        entry.tools_used.push({ ...use });
      }
    }
  }

  return [...byKey.values()]
    .map((entry) => ({
      ...entry,
      tools_used: entry.tools_used.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => Number(b.live) - Number(a.live) || b.calls - a.calls || (a.client?.name ?? "").localeCompare(b.client?.name ?? ""));
}

function esc(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string,
  );
}

function when(value: string | null): string {
  if (!value) return "—";
  return value.replace("T", " ").replace("Z", "").slice(0, 19);
}

function spark(value: number): string {
  return value === 0 ? "—" : String(value);
}

function renderHtml(ctx: AppContext): string {
  const totals = toolTotals();
  const tools = toolRows();
  const sessions = snapshotMcpSessions();
  const clients = buildClients(sessions, clientRows());
  const recent = recentRows();

  const toolLines = tools
    .map(
      (tool) => `<tr>
        <td class="mono">${esc(tool.tool_name)}</td>
        <td class="num">${spark(tool.calls)}</td>
        <td class="num ${tool.failed > 0 ? "bad" : ""}">${tool.failed > 0 ? tool.failed : "—"}</td>
        <td class="num">${tool.clients > 0 ? tool.clients : "—"}</td>
        <td class="muted">${esc(when(tool.last_call))}</td>
      </tr>`,
    )
    .join("");

  const clientLines = clients
    .map((client) => {
      const label = client.client
        ? `${esc(client.client.name)}<div class="sub mono">${esc(client.client.version)}</div>`
        : `<span class="muted">anonymous</span>`;
      const tools_used =
        client.tools_used.length > 0
          ? client.tools_used
              .map(
                (tool) =>
                  `<span class="chip">${esc(tool.name)} ×${tool.calls}${tool.failed > 0 ? ` <b class="bad">(${tool.failed} failed)</b>` : ""}</span>`,
              )
              .join(" ")
          : `<span class="muted">no tool calls yet</span>`;
      return `<tr>
        <td>${label}${client.live ? ` <span class="live">live</span>` : ""}</td>
        <td class="mono">${client.session ?? "—"}</td>
        <td>${client.transport ? `${esc(client.transport)}<div class="sub mono">${esc(client.protocol ?? "")}</div>` : "—"}</td>
        <td class="num">${client.requests === null ? "—" : client.requests}</td>
        <td>${tools_used}</td>
        <td class="muted">${esc(when(client.last_seen))}</td>
      </tr>`;
    })
    .join("");

  const recentLines = recent
    .map(
      (row) => `<tr>
        <td class="muted">${esc(when(row.ts))}</td>
        <td>${esc(row.client_name ?? "unknown")}${row.client_version ? `<div class="sub mono">${esc(row.client_version)}</div>` : ""}</td>
        <td class="mono">${esc(shortId(row.session_id) ?? "—")}</td>
        <td class="mono">${esc(row.tool_name)}</td>
        <td><span class="tag ${row.status === "error" ? "bad" : "ok"}">${esc(row.status)}</span></td>
        <td class="num">${row.duration_ms} ms</td>
      </tr>`,
    )
    .join("");

  const empty = (columns: number, text: string): string =>
    `<tr><td colspan="${columns}" class="muted">${text}</td></tr>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="5">
<title>MCP clients · ${esc(ctx.identity.identity.name)}</title>
<style>
  :root { color-scheme: dark; --bg:#0d1117; --panel:#151b24; --line:#26303d; --ink:#e6edf3; --muted:#8b98a9; --ok:#3fb950; --bad:#f85149; --chip:#1f2833; }
  * { box-sizing: border-box; }
  body { margin:0; padding:28px; background:var(--bg); color:var(--ink); font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  header { display:flex; flex-wrap:wrap; align-items:baseline; gap:12px; margin-bottom:20px; }
  h1 { margin:0; font-size:22px; font-weight:650; }
  h1 small { color:var(--muted); font-weight:400; font-size:13px; }
  .grow { flex:1; }
  a { color:#58a6ff; text-decoration:none; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:18px; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .card .k { color:var(--muted); font-size:11px; letter-spacing:.08em; text-transform:uppercase; }
  .card .v { font-size:22px; font-weight:650; margin-top:4px; }
  section { background:var(--panel); border:1px solid var(--line); border-radius:10px; margin-bottom:16px; overflow:hidden; }
  .head { display:flex; align-items:baseline; gap:10px; padding:12px 14px; border-bottom:1px solid var(--line); }
  .head h2 { margin:0; font-size:13px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted); font-weight:600; }
  .head .count { color:var(--muted); font-size:12px; }
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:9px 14px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-size:11px; letter-spacing:.06em; text-transform:uppercase; font-weight:600; }
  tr:last-child td { border-bottom:0; }
  .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; }
  .sub { color:var(--muted); font-size:11.5px; margin-top:2px; }
  .muted { color:var(--muted); }
  .bad { color:var(--bad); }
  .ok { color:var(--ok); }
  .live { display:inline-block; margin-left:6px; padding:1px 6px; border:1px solid #1f6f3f; border-radius:999px; color:var(--ok); font-size:10.5px; letter-spacing:.04em; text-transform:uppercase; }
  .chip { display:inline-block; margin:1px 4px 1px 0; padding:2px 8px; background:var(--chip); border-radius:999px; font-size:12px; }
  .tag { display:inline-block; padding:1px 7px; border-radius:999px; background:var(--chip); font-size:11.5px; }
  footer { color:var(--muted); font-size:12px; display:flex; flex-wrap:wrap; gap:14px; }
  @media (max-width:720px) { body { padding:16px; } th, td { padding:8px 10px; } }
</style>
</head>
<body>
<header>
  <h1>MCP clients <small>· ${esc(ctx.identity.identity.name)} ${esc(ctx.identity.identity.version)}</small></h1>
  <span class="grow"></span>
  <a href="/client.json">JSON</a>
  <a href="/admin/ui">Admin UI</a>
</header>

<div class="cards">
  <div class="card"><div class="k">Tools</div><div class="v">${TOOL_NAMES.length}</div></div>
  <div class="card"><div class="k">Live sessions</div><div class="v">${sessions.length}</div></div>
  <div class="card"><div class="k">Tool calls</div><div class="v">${totals.calls}</div></div>
  <div class="card"><div class="k">Failed calls</div><div class="v ${totals.failed > 0 ? "bad" : ""}">${totals.failed}</div></div>
</div>

<section>
  <div class="head"><h2>Connected clients</h2><span class="count">${clients.length} client${clients.length === 1 ? "" : "s"}</span></div>
  <table>
    <thead><tr><th>Client</th><th>Session</th><th>Transport</th><th class="num">Requests</th><th>Tools used</th><th>Last seen</th></tr></thead>
    <tbody>${clients.length ? clientLines : empty(6, "No client has connected yet.")}</tbody>
  </table>
</section>

<section>
  <div class="head"><h2>Tools</h2><span class="count">${TOOL_NAMES.length} registered</span></div>
  <table>
    <thead><tr><th>Tool</th><th class="num">Calls</th><th class="num">Failed</th><th class="num">Clients</th><th>Last call</th></tr></thead>
    <tbody>${toolLines}</tbody>
  </table>
</section>

<section>
  <div class="head"><h2>Recent calls</h2><span class="count">last ${recent.length}</span></div>
  <table>
    <thead><tr><th>Time</th><th>Client</th><th>Session</th><th>Tool</th><th>Status</th><th class="num">Duration</th></tr></thead>
    <tbody>${recent.length ? recentLines : empty(6, "No tool calls recorded yet.")}</tbody>
  </table>
</section>

<footer>
  <span>Auto-refresh every 5s · generated ${esc(new Date().toISOString().replace("T", " ").slice(0, 19))}Z</span>
  <span>Session ids are truncated · client names are self-declared in <span class="mono">initialize</span></span>
</footer>
</body>
</html>`;
}

function renderJson(ctx: AppContext): Record<string, unknown> {
  const totals = toolTotals();
  const sessions = snapshotMcpSessions();
  const clients = buildClients(sessions, clientRows());
  return {
    object: "mcp.client_usage",
    generated_at: new Date().toISOString(),
    identity: { name: ctx.identity.identity.name, version: ctx.identity.identity.version },
    tools_total: TOOL_NAMES.length,
    calls: totals.calls,
    failed: totals.failed,
    sessions: sessions.length,
    tools: toolRows().map((tool) => ({
      name: tool.tool_name,
      calls: tool.calls,
      failed: tool.failed,
      clients: tool.clients,
      last_call: tool.last_call,
    })),
    clients,
    recent_calls: recentRows().map((row) => ({
      ts: row.ts,
      tool: row.tool_name,
      status: row.status,
      duration_ms: row.duration_ms,
      client_name: row.client_name,
      client_version: row.client_version,
      session: shortId(row.session_id),
    })),
  };
}

export function handleClientPage(
  ctx: AppContext,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
): boolean {
  if (req.method !== "GET") return false;

  if (path === "/client") {
    const html = renderHtml(ctx);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(html),
    });
    res.end(html);
    return true;
  }

  if (path === "/client.json") {
    const body = JSON.stringify(renderJson(ctx));
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
    return true;
  }

  return false;
}
