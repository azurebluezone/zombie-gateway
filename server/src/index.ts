/**
 * Gateway bootstrap.
 *
 * Startup never blocks on a provider probe: a cold llama.cpp server can take
 * minutes to load a model, and the gateway must still answer /health so that
 * scripts can tell the difference between "gateway down" and "model loading".
 *
 * The database is the provider truth; the environment only seeds it.
 */

import type { Socket } from "node:net";
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
  // Two sets, because "open" and "in flight" are different questions at
  // shutdown. A socket that never sent a request has nothing to drain, but
  // `closeIdleConnections()` does not always recognise it: a pooled client can
  // open a connection and leave it silent, and that socket would otherwise hold
  // the process until the force-close timer.
  const openSockets = new Set<Socket>();
  const busySockets = new Set<Socket>();
  server.on("connection", (socket) => {
    openSockets.add(socket);
    socket.on("close", () => {
      openSockets.delete(socket);
      busySockets.delete(socket);
    });
  });
  server.on("request", (req, res) => {
    const socket = req.socket;
    busySockets.add(socket);
    const release = (): void => {
      busySockets.delete(socket);
    };
    res.on("finish", release);
    res.on("close", release);
  });
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

  let closing = false;
  const finish = (): void => {
    if (closing) return;
    closing = true;
    closeTransports();
    closeDatabase();
    process.exit(0);
  };

  const shutdown = (signal: string): void => {
    logEvent("info", "gateway.shutdown", { signal });
    clearInterval(timer);
    server.close(() => {
      logEvent("info", "gateway.closed", {});
      finish();
    });
    // Nothing is in flight on these, so there is nothing to drain: cut them
    // before waiting rather than after the grace period.
    for (const socket of openSockets) {
      if (!busySockets.has(socket)) socket.destroy();
    }
    // Keep-alive sockets are idle, not in-flight. Without this, `server.close`
    // waits for the 65 s keep-alive timeout on every stop.
    server.closeIdleConnections();
    // A streaming response gets a grace period to finish; after that the socket
    // is cut instead of holding the process open indefinitely.
    setTimeout(() => {
      server.getConnections((error, count) => {
        logEvent("warn", "gateway.force_close", {
          connections: count,
          peers: [...openSockets].map((socket) => ({
            remote: `${socket.remoteAddress}:${socket.remotePort}`,
            destroyed: socket.destroyed,
            readable: socket.readable,
            writable: socket.writable,
          })),
          error: error?.message ?? null,
        });
        server.closeAllConnections();
        finish();
      });
    }, 3_000).unref();
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
