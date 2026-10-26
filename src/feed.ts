import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import type { Envelope } from "./envelope.js";

const TIMEOUT_MS = 15_000;

export class FeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeedError";
  }
}

export interface FeedOptions {
  sourceId: string;
  socketPath?: string;
  agentinboxBin?: string;
  timeoutMs?: number;
}

export async function feed(envelope: Envelope, options: FeedOptions): Promise<void> {
  const socketPath = options.socketPath ?? agentInboxSocketPath();
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  try {
    await feedHttp(envelope, options.sourceId, socketPath, timeoutMs);
    return;
  } catch (httpError) {
    try {
      await feedCli(
        envelope,
        options.sourceId,
        options.agentinboxBin ?? resolveAgentInboxBin(),
        timeoutMs,
      );
      return;
    } catch (cliError) {
      throw new FeedError(
        `agentinbox rejected event: ${errorDetail(httpError)}; CLI fallback: ${errorDetail(cliError)}`,
      );
    }
  }
}

export function agentInboxSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AGENTINBOX_SOCKET) {
    return path.resolve(env.AGENTINBOX_SOCKET);
  }
  const home = env.AGENTINBOX_HOME
    ? path.resolve(env.AGENTINBOX_HOME)
    : path.join(homedir(), ".agentinbox");
  return path.join(home, "agentinbox.sock");
}

export function resolveAgentInboxBin(): string {
  try {
    const require = createRequire(import.meta.url);
    const manifestPath = require.resolve("@holon-run/agentinbox/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const relative =
      typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.agentinbox;
    if (relative) {
      return path.resolve(path.dirname(manifestPath), relative);
    }
  } catch {
    // The dependency may be missing in a source checkout; PATH is the fallback.
  }
  return "agentinbox";
}

export function buildCliCommand(
  envelope: Envelope,
  sourceId: string,
  agentinboxBin: string,
): string[] {
  return [
    agentinboxBin,
    "source",
    "event",
    sourceId,
    "--native-id",
    envelope.native_id,
    "--event",
    envelope.event,
    "--occurred-at",
    envelope.occurred_at,
    "--metadata-json",
    JSON.stringify(envelope.metadata()),
    "--payload-json",
    JSON.stringify(envelope.payload),
  ];
}

async function feedHttp(
  envelope: Envelope,
  sourceId: string,
  socketPath: string,
  timeoutMs: number,
): Promise<void> {
  const payload = JSON.stringify({
    sourceNativeId: envelope.native_id,
    eventVariant: envelope.event,
    occurredAt: envelope.occurred_at,
    metadata: envelope.metadata(),
    rawPayload: envelope.payload,
  });

  await new Promise<void>((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        path: `/sources/${encodeURIComponent(sourceId)}/events`,
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            resolve();
            return;
          }
          const detail = oneLine(Buffer.concat(chunks).toString("utf8")).slice(0, 300);
          reject(new FeedError(`agentinbox HTTP ${status}${detail ? `: ${detail}` : ""}`));
        });
      },
    );
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`timed out after ${timeoutMs}ms`));
    });
    request.on("error", (error) => {
      reject(new FeedError(`agentinbox socket request failed: ${error.message}`));
    });
    request.end(payload);
  });
}

async function feedCli(
  envelope: Envelope,
  sourceId: string,
  agentinboxBin: string,
  timeoutMs: number,
): Promise<void> {
  const command = buildCliCommand(envelope, sourceId, agentinboxBin);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let stderr = "";
    const child = spawn(command[0]!, command.slice(1), {
      stdio: ["ignore", "ignore", "pipe"],
    });

    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new FeedError(`agentinbox CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-4096);
    });
    child.once("error", (error) => {
      finish(new FeedError(`cannot run ${command[0]}: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        finish();
        return;
      }
      const detail = oneLine(stderr).slice(0, 300);
      finish(
        new FeedError(
          `agentinbox exited ${code ?? signal ?? "unknown"}${detail ? `: ${detail}` : ""}`,
        ),
      );
    });
  });
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function errorDetail(error: unknown): string {
  return oneLine(error instanceof Error ? error.message : String(error)).slice(0, 500);
}
