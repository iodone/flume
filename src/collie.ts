import http from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import path from "node:path";
import type { Envelope } from "./envelope.js";

const TIMEOUT_MS = 15_000;
export class CollieFeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollieFeedError";
  }
}

export interface CollieSink {
  source: string;
  socketPath?: string;
  url?: string;
  timeoutMs?: number;
}

export function collieSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(
    env.FLUME_COLLIE_SOCKET ??
      path.join(homedir(), ".local", "state", "collie", "service.sock"),
  );
}

/**
 * Forward the normalized flume envelope to Collie. Flume owns webhook
 * verification and normalization; Collie owns persistence, dedupe, merge and
 * coordinator dispatch. The envelope is open-ended and is never mapped to a
 * VCS object here.
 */
export async function feedCollie(
  envelope: Envelope,
  sink: CollieSink,
): Promise<void> {
  const endpoint = `/v1/in/${encodeURIComponent(sink.source)}`;
  const timeoutMs = sink.timeoutMs ?? TIMEOUT_MS;
  const body = Buffer.from(JSON.stringify(envelope.toJSON()));
  const outgoing: http.OutgoingHttpHeaders = {
    "content-type": "application/json",
    "content-length": body.length,
  };

  await new Promise<void>((resolve, reject) => {
    const fail = (error: Error): void => reject(new CollieFeedError(error.message));
    let request: http.ClientRequest;
    if (sink.url) {
      let target: URL;
      try {
        target = new URL(sink.url);
      } catch {
        reject(new CollieFeedError("FLUME_COLLIE_URL must be an absolute HTTP(S) URL"));
        return;
      }
      if (target.protocol !== "http:" && target.protocol !== "https:") {
        reject(new CollieFeedError("FLUME_COLLIE_URL must be an absolute HTTP(S) URL"));
        return;
      }
      const base = target.pathname.replace(/\/+$/, "");
      const transport = target.protocol === "https:" ? https : http;
      request = transport.request({
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${base}${endpoint}`,
        method: "POST",
        headers: outgoing,
      }, (response) => finish(response, resolve, reject));
    } else {
      request = http.request({
        socketPath: sink.socketPath ?? collieSocketPath(),
        path: endpoint,
        method: "POST",
        headers: outgoing,
      }, (response) => finish(response, resolve, reject));
    }

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`timed out after ${timeoutMs}ms`));
    });
    request.on("error", (error) => fail(new Error(`collie request failed: ${error.message}`)));
    request.end(body);
  });
}

function finish(
  response: http.IncomingMessage,
  resolve: () => void,
  reject: (error: Error) => void,
): void {
  const chunks: Buffer[] = [];
  response.on("data", (chunk: Buffer) => chunks.push(chunk));
  response.on("end", () => {
    const status = response.statusCode ?? 0;
    if (status >= 200 && status < 300) {
      resolve();
      return;
    }
    const detail = Buffer.concat(chunks).toString("utf8").replace(/\s+/g, " ").slice(0, 300);
    reject(new CollieFeedError(`collie HTTP ${status}${detail ? `: ${detail}` : ""}`));
  });
}
