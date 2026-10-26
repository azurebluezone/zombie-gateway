/**
 * Gateway bootstrap.
 *
 * Startup never blocks on a provider probe: a cold llama.cpp server can take
 * minutes to load a model, and the gateway must still answer /health so that
 * scripts can tell the difference between "gateway down" and "model loading".
 *
 * The database is the provider truth; the environment only seeds it.
 */

import { readGatewayConfig } from "./config.ts";
import { createServer } from "./server.ts";
import { closeDatabase, openDatabase } from "./core/db.ts";
import { initLogger, logEvent } from "./core/logger.ts";
import { syncAll } from "./core/catalog.ts";
import { ProviderRegistry } from "./core/registry.ts";
import { closeTransports } from "./transport/request.ts";
import { loadIdentity } from "./identity.ts";
import { loadPolicy } from "./core/policy.ts";
import type { AppContext } from "./core/chat.ts";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

async function main(): Promise<void> {
  const config = readGatewayConfig();
  initLogger(config.logPath);
  openDatabase(config.dbPath);

  const registry = new ProviderRegistry();
  registry.seed(config.providers);

  const identity = loadIdentity(config.identityFile || undefined);
  if (!identity.valid) {
    logEvent("warn", "identity.invalid", { file: identity.source });
  }

  const policy = loadPolicy(config.policy, config.policyFile || undefined);
  logEvent(policy.enabled ? "info" : "warn", "policy.loaded", {
    enabled: policy.enabled,
    reason: policy.reason,
    file: policy.source,
    sha256: policy.sha256 || null,
    tokens: policy.tokens,
    mode: config.policy,
  });

  if (!config.adminToken && !LOOPBACK.has(config.host)) {
    logEvent("warn", "admin.exposed", {
      host: config.host,
      message: "Admin API is reachable without a token; set GATEWAY_ADMIN_TOKEN",
    });
  }

  const context: AppContext = {
    config,
    providers: registry.map,
    registry,
    identity,
    policy,
  };

  logEvent("info", "gateway.ready", {
    host: config.host,
    port: config.port,
    db: config.dbPath,
    log: config.logPath,
    identity: identity.identity.name,
    identity_version: identity.identity.version,
    identity_sha256: identity.sha256,
    admin_token: config.adminToken !== null,
    providers: registry.list(true).map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      transport: provider.transport,
      enabled: provider.enabled,
      source: provider.source,
    })),
  });

  const server = createServer(context);
  server.listen(config.port, config.host, () => {
    logEvent("info", "gateway.listening", {
      url: `http://${config.host}:${config.port}`,
    });
  });

  const runSync = (reason: string): void => {
    void syncAll(registry.list())
      .then((reports) => {
        logEvent("info", "catalog.synced", { reason, reports });
      })
      .catch((error: unknown) => {
        logEvent("error", "catalog.sync_failed", {
          reason,
          message: error instanceof Error ? error.message : String(error),
        });
      });
  };

  runSync("startup");
  const timer = setInterval(() => runSync("interval"), config.syncIntervalMs);
  timer.unref();

  const shutdown = (signal: string): void => {
    logEvent("info", "gateway.shutdown", { signal });
    clearInterval(timer);
    server.close(() => {
      closeTransports();
      closeDatabase();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5_000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    logEvent("error", "gateway.unhandled_rejection", {
      message: reason instanceof Error ? reason.message : String(reason),
    });
  });
}

void main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      level: "error",
      event: "gateway.boot_failed",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
});
