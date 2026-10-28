/**
 * Gateway bootstrap.
 *
 * Startup never blocks on a provider probe: a cold llama.cpp server can take
 * minutes to load a model, and the gateway must still answer /health so that
 * scripts can tell the difference between "gateway down" and "model loading".
 *
 * The database is the provider truth; the environment only seeds it.
 */

import type { Server } from "node:http";
import net, { type Socket } from "node:net";
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { readGatewayConfig } from "./config.ts";
import { createServer } from "./server.ts";
import { closeDatabase, openDatabase } from "./core/db.ts";
import { initAccessLog } from "./core/access.ts";
import { initLogger, logEvent } from "./core/logger.ts";
import { syncAll } from "./core/catalog.ts";
import { ProviderRegistry } from "./core/registry.ts";
import { closeTransports } from "./transport/request.ts";
import { closeAdminSockets } from "./admin/ws.ts";
import { loadIdentity } from "./identity.ts";
import { loadPolicy } from "./core/policy.ts";
import type { AppContext } from "./core/chat.ts";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

async function main(): Promise<void> {
  const config = readGatewayConfig();
  initLogger(config.logPath);
  initAccessLog(config.accessLogPath);
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
    access_log: config.accessLogPath,
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
  // Socket-only deployments are valid: GATEWAY_PORT empty, GATEWAY_SOCKET set.
  // The TCP server object still exists (it is harmless), but it never listens,
  // so every listen/close/connection call below is guarded by this flag.
  const tcpEnabled = config.port !== null;
  // Two sets, because "open" and "in flight" are different questions at
  // shutdown. A socket that never sent a request has nothing to drain, but
  // `closeIdleConnections()` does not always recognise it: a pooled client can
  // open a connection and leave it silent, and that socket would otherwise hold
  // the process until the force-close timer.
  const openSockets = new Set<Socket>();
  const busySockets = new Set<Socket>();
  const track = (target: Server): void => {
    target.on("connection", (socket) => {
      openSockets.add(socket);
      socket.on("close", () => {
        openSockets.delete(socket);
        busySockets.delete(socket);
      });
    });
    target.on("request", (req, res) => {
      const socket = req.socket;
      busySockets.add(socket);
      const release = (): void => {
        busySockets.delete(socket);
      };
      res.on("finish", release);
      res.on("close", release);
    });
  };
  track(server);
  if (config.port !== null) {
    const port = config.port;
    server.listen(port, config.host, () => {
      logEvent("info", "gateway.listening", {
        url: `http://${config.host}:${port}`,
      });
    });
  }

  // Optional second listener over a Unix domain socket. Same handler, same
  // auth switch, same admin routes: a local client can skip TCP entirely and
  // never expose a port. On Windows Node's equivalent is a named pipe path
  // (`\\.\pipe\name`), which has no file to unlink or chmod.
  let socketServer: Server | null = null;
  const socketPath = config.socketPath;
  if (socketPath) {
    const isPipe = process.platform === "win32" && socketPath.startsWith("\\\\.\\pipe\\");
    if (process.platform === "win32" && !isPipe) {
      throw new Error(
        `GATEWAY_SOCKET on Windows must be a named pipe (\\.\\pipe\\name), got "${socketPath}"`,
      );
    }
    if (!isPipe) {
      mkdirSync(dirname(socketPath), { recursive: true });
      if (existsSync(socketPath)) {
        // A stale file from a killed process is normal; a live socket is not.
        // Refuse to unlink a socket somebody is still answering on.
        const alive = await new Promise<boolean>((resolve) => {
          const probe = net.connect({ path: socketPath });
          const done = (value: boolean): void => {
            probe.destroy();
            resolve(value);
          };
          probe.once("connect", () => done(true));
          probe.once("error", () => done(false));
          setTimeout(() => done(false), 300).unref();
        });
        if (alive) throw new Error(`GATEWAY_SOCKET ${socketPath} is already in use`);
        unlinkSync(socketPath);
        logEvent("warn", "gateway.socket_stale", { path: socketPath });
      }
    }

    socketServer = createServer(context);
    track(socketServer);
    socketServer.on("error", (error: unknown) => {
      logEvent("error", "gateway.socket_failed", {
        path: socketPath,
        message: error instanceof Error ? error.message : String(error),
      });
      process.exit(1);
    });
    socketServer.listen(socketPath, () => {
      if (!isPipe) chmodSync(socketPath, config.socketMode);
      logEvent("info", "gateway.socket_listening", {
        path: socketPath,
        mode: isPipe ? "pipe" : config.socketMode.toString(8),
      });
    });
  }

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

    // One process, up to two listeners: wait for all of them before exiting,
    // and delete the socket file so the next boot does not have to guess.
    const removeSocketFile = (): void => {
      if (!socketPath || process.platform === "win32") return;
      try {
        unlinkSync(socketPath);
      } catch {
        // Already gone: unlinking twice is not an error worth a log line.
      }
    };
    const servers: Server[] = tcpEnabled ? [server] : [];
    if (socketServer !== null) servers.push(socketServer);
    let pendingCloses = servers.length;
    const closed = (): void => {
      pendingCloses -= 1;
      if (pendingCloses > 0) return;
      removeSocketFile();
      logEvent("info", "gateway.closed", {});
      finish();
    };
    for (const target of servers) target.close(closed);
    // Panels get a close frame before the wire goes down; a session row is
    // closed by the same call, so shutdown leaves no half-open rows behind.
    const websockets = closeAdminSockets();
    if (websockets > 0) {
      logEvent("info", "gateway.websockets_closed", { count: websockets });
    }
    // Nothing is in flight on these, so there is nothing to drain: cut them
    // before waiting rather than after the grace period.
    for (const socket of openSockets) {
      if (!busySockets.has(socket)) socket.destroySoon();
    }
    // Keep-alive sockets are idle, not in-flight. Without this, close() waits
    // for the 65 s keep-alive timeout on every stop.
    for (const target of servers) target.closeIdleConnections();
    // A streaming response gets a grace period to finish; after that the socket
    // is cut instead of holding the process open indefinitely.
    setTimeout(() => {
      const forceClose = (connections: number | null, error: string | null): void => {
        logEvent("warn", "gateway.force_close", {
          connections,
          peers: [...openSockets].map((socket) => ({
            remote: `${socket.remoteAddress}:${socket.remotePort}`,
            destroyed: socket.destroyed,
            readable: socket.readable,
            writable: socket.writable,
          })),
          error,
        });
        for (const target of servers) target.closeAllConnections();
        removeSocketFile();
        finish();
      };
      if (tcpEnabled) {
        server.getConnections((error, count) => forceClose(count, error?.message ?? null));
      } else {
        forceClose(null, null);
      }
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
