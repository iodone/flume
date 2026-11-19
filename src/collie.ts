import http from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import path from "node:path";
import type { IncomingHttpHeaders } from "node:http";

const TIMEOUT_MS = 15_000;
const SKIP_HEADERS = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "keep-alive",
  "proxy-connection",
  "upgrade",
]);

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
 * Forward the original webhook to Collie's source adapter. Collie owns the
 * Event shape (data_ref, merge lane, space mapping), so flume must not
 * re-encode the body: the signature and the bytes must stay identical.
 */
export async function feedCollie(
  headers: IncomingHttpHeaders,
  body: Buffer,
  sink: CollieSink,
): Promise<void> {
  const endpoint = `/v1/in/${encodeURIComponent(sink.source)}`;
  const timeoutMs = sink.timeoutMs ?? TIMEOUT_MS;
  const outgoing: http.OutgoingHttpHeaders = { "content-length": body.length };
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || SKIP_HEADERS.has(name.toLowerCase())) continue;
    outgoing[name] = value;
  }

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
