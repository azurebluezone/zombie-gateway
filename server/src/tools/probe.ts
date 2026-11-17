/**
 * Catalogue probe.
 *
 * Runs discovery against every enabled provider (environment seed + admin rows)
 * and prints one row per model. Exit code 0 means at least one provider answered.
 */

import { readGatewayConfig } from "../config.ts";
import { closeDatabase, openDatabase } from "../core/db.ts";
import { initLogger, logEvent } from "../core/logger.ts";
import { listPublicModels, syncAll } from "../core/catalog.ts";
import { ProviderRegistry } from "../core/registry.ts";

async function main(): Promise<void> {
  const config = readGatewayConfig();
  initLogger("", false);
  openDatabase(config.dbPath);

  const registry = new ProviderRegistry();
  registry.seed(config.providers);
  const providers = registry.list();

  if (providers.length === 0) {
    console.error("No enabled providers. Seed one with CP_<ID>_BASE_URL or POST /admin/providers.");
    closeDatabase();
    process.exit(1);
  }

  const reports = await syncAll(providers);
  for (const report of reports) {
    logEvent(report.ok ? "info" : "error", "probe.provider", { ...report });
  }

  const models = listPublicModels();
  const header = ["provider", "model", "caps", "ctx", "quant", "source"];
  const rows = models.map((model) => [
    model.providerId,
    model.modelId,
    model.caps.join("+") || "-",
    model.contextLength === null ? "-" : String(model.contextLength),
    model.quantization ?? "-",
    model.source,
  ]);

  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => (row[index] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join("  ");

  console.log(line(header));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(line(row));

  closeDatabase();
  process.exit(reports.some((report) => report.ok) ? 0 : 1);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
