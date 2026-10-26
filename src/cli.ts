#!/usr/bin/env node

import { spawn, type ChildProcess } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ConfigError,
  configFromEnv,
  createFlumeServer,
  localAddress,
  type Config,
} from "./core.js";
import { environmentWithOptionalFile } from "./env.js";
import { agentInboxSocketPath, resolveAgentInboxBin } from "./feed.js";

const DAEMON_START_TIMEOUT_MS = 15_000;
const DAEMON_POLL_MS = 100;

interface Daemon {
  socketPath: string;
  child: ChildProcess | null;
}

export interface EnsureAgentInboxOptions {
  autostart?: boolean;
  timeoutMs?: number;
}

export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const command = argv[0];
  if (command === "--help" || command === "-h" || command === "help") {
    process.stdout.write("Usage: flume start\n");
    return 0;
  }
  if (command !== "start") {
    process.stderr.write("Usage: flume start\n");
    return 2;
  }

  let config: Config;
  let runtimeEnv: NodeJS.ProcessEnv;
  try {
    runtimeEnv = await environmentWithOptionalFile(env);
    config = configFromEnv(runtimeEnv);
  } catch (error) {
    const message = error instanceof ConfigError ? error.message : String(error);
    process.stderr.write(`flume: ${message}\n`);
    return 2;
  }

  let daemon: Daemon | null = null;
  try {
    daemon = await ensureAgentInbox(daemonEnvironment(runtimeEnv));
    const server = createFlumeServer(config);
    await listen(server, config);
    const address = localAddress(server);
    const mode = daemon.child ? "started" : "attached";
    process.stdout.write(
      `flume: listening on ${address.address}:${address.port}; agentinbox ${mode} at ${daemon.socketPath}\n`,
    );
    installShutdown(server, daemon.child);
    return 0;
  } catch (error) {
    daemon?.child?.kill("SIGTERM");
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`flume: ${message}\n`);
    return 1;
  }
}

export async function ensureAgentInbox(
  env: NodeJS.ProcessEnv = process.env,
  options: EnsureAgentInboxOptions = {},
): Promise<Daemon> {
  const socketPath = agentInboxSocketPath(env);
  if (await socketIsAlive(socketPath)) {
    return { socketPath, child: null };
  }

  const timeoutMs = options.timeoutMs ?? DAEMON_START_TIMEOUT_MS;
  const autostart = options.autostart ?? env.FLUME_AGENTINBOX_AUTOSTART !== "0";
  if (!autostart) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(DAEMON_POLL_MS);
      if (await socketIsAlive(socketPath)) {
        return { socketPath, child: null };
      }
    }
    throw new Error(
      `agentinbox is not running at ${socketPath}; FLUME_AGENTINBOX_AUTOSTART=0`,
    );
  }

  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  const bin = resolveAgentInboxBin();
  const child = spawn(bin, ["serve"], {
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  let spawnError: Error | undefined;
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4096);
  });
  child.once("error", (error) => {
    spawnError = error;
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await socketIsAlive(socketPath)) {
      return { socketPath, child };
    }
    if (spawnError) {
      throw new Error(`cannot run ${bin}: ${spawnError.message}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      if (await socketIsAlive(socketPath)) {
        return { socketPath, child: null };
      }
      const detail = oneLine(stderr).slice(0, 300);
      throw new Error(
        `agentinbox serve exited ${child.exitCode ?? child.signalCode ?? "unknown"}${detail ? `: ${detail}` : ""}`,
      );
    }
    await sleep(DAEMON_POLL_MS);
  }

  child.kill("SIGTERM");
  throw new Error(
    `agentinbox did not open ${socketPath} within ${timeoutMs}ms`,
  );
}

function daemonEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([key]) => !/^FLUME_.*_TOKEN$/.test(key)),
  );
}

function socketIsAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (alive: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(alive);
    };
    socket.setTimeout(300, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function listen(server: ReturnType<typeof createFlumeServer>, config: Config): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.bind);
  });
}

function installShutdown(
  server: ReturnType<typeof createFlumeServer>,
  ownedDaemon: ChildProcess | null,
): void {
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    ownedDaemon?.kill("SIGTERM");
    server.close(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("exit", () => {
    ownedDaemon?.kill("SIGTERM");
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

if (isEntrypoint()) {
  void main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`flume: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(entry).href === import.meta.url;
  }
}
