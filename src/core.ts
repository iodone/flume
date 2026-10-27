import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  Activation,
  ActivationError,
  DEFAULT_WAKE_TIMEOUT_MS,
  dispatchActivation,
  dispatchHerdrPrompt,
  WakeGateError,
} from "./activation.js";
import { allAdapters, getAdapter } from "./adapters/index.js";
import {
  EnvelopeError,
  isJsonObject,
  type Envelope,
  type JsonObject,
} from "./envelope.js";
import { feed as defaultFeed, type FeedOptions } from "./feed.js";

export const MAX_BODY_BYTES = 8 * 1024 * 1024;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface Config {
  bind: string;
  port: number;
  sourceId: string;
  secrets: Record<string, string>;
  wakeUrl?: string;
  wakeAgent?: string;
  inboxAgent?: string;
  herdrBin?: string;
  wakeTimeoutMs?: number;
}

export type FeedFunction = (
  envelope: Envelope,
  options: Pick<FeedOptions, "sourceId">,
) => Promise<void> | void;

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
  const required = [
    "AGENTINBOX_SOURCE_ID",
    ...allAdapters().map((adapter) => adapter.SECRET_ENV),
  ];
  const missing = required.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new ConfigError(`missing env: ${missing.join(", ")}`);
  }

  const portText = env.FLUME_PORT || "9420";
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ConfigError("FLUME_PORT must be an integer from 0 to 65535");
  }

  const timeoutText = env.FLUME_HERDR_WAKE_TIMEOUT || "5";
  const timeoutSeconds = Number(timeoutText);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new ConfigError("FLUME_HERDR_WAKE_TIMEOUT must be positive");
  }

  return {
    bind: env.FLUME_BIND || "127.0.0.1",
    port,
    sourceId: env.AGENTINBOX_SOURCE_ID!,
    secrets: Object.fromEntries(
      allAdapters().map((adapter) => [adapter.NAME, env[adapter.SECRET_ENV]!]),
    ),
    wakeUrl: env.FLUME_HERDR_WAKE_URL?.trim() || undefined,
    wakeAgent: env.FLUME_HERDR_WAKE_AGENT?.trim() || undefined,
    inboxAgent: env.FLUME_AGENTINBOX_AGENT_ID?.trim() || undefined,
    herdrBin: env.HERDR_BIN_PATH?.trim() || "herdr",
    wakeTimeoutMs: timeoutSeconds * 1_000,
  };
}

export function createFlumeServer(
  config: Config,
  feedFn: FeedFunction = defaultFeed,
): Server {
  return createServer((request, response) => {
    void handleRequest(config, feedFn, request, response);
  });
}

export function localAddress(server: Server): AddressInfo {
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server is not listening on a TCP address");
  }
  return address;
}

async function handleRequest(
  config: Config,
  feedFn: FeedFunction,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = url.pathname.replace(/^\/+|\/+$/g, "");

  if (request.method === "GET" && pathname === "healthz") {
    sendJson(response, 200, { ok: true });
    return;
  }
  if (request.method !== "POST") {
    request.resume();
    sendJson(response, 404, { error: "not found" }, true);
    return;
  }

  if (pathname === "activation") {
    if (!isLoopbackAddress(request.socket.remoteAddress)) {
      request.resume();
      console.error(
        `flume: reject activation from non-loopback ${request.socket.remoteAddress ?? "unknown"}`,
      );
      sendJson(response, 403, { error: "activation is loopback-only" }, true);
      return;
    }
    await handleActivation(config, request, response);
    return;
  }

  const adapter = getAdapter(pathname);
  if (!adapter) {
    request.resume();
    sendJson(
      response,
      404,
      { error: `unknown adapter: ${pathname || "/"}` },
      true,
    );
    return;
  }

  let body: Buffer;
  try {
    body = await readBody(request);
  } catch (error) {
    if (error instanceof EmptyBodyError) {
      sendJson(response, 400, { error: "empty body" });
    } else if (error instanceof BodyTooLargeError) {
      sendJson(response, 413, { error: "body too large" }, true);
    } else {
      sendJson(response, 400, { error: "bad request" });
    }
    return;
  }

  const secret = config.secrets[adapter.NAME];
  if (!adapter.verify(request.headers, body, secret)) {
    console.error(`flume: reject ${adapter.NAME}: bad token`);
    sendJson(response, 401, { error: "invalid token" });
    return;
  }

  let document: JsonObject;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const parsed: unknown = JSON.parse(text);
    if (!isJsonObject(parsed)) {
      sendJson(response, 400, { error: "payload must be a JSON object" });
      return;
    }
    document = parsed;
  } catch {
    sendJson(response, 400, { error: "invalid json" });
    return;
  }

  let envelope;
  try {
    envelope = adapter.normalize(request.headers, body, document);
  } catch (error) {
    if (error instanceof EnvelopeError) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    console.error(`flume: normalize failed for ${adapter.NAME}`);
    sendJson(response, 500, { error: "internal error" });
    return;
  }

  try {
    await feedFn(envelope, { sourceId: config.sourceId });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`flume: feed failed for ${envelope.event}: ${detail}`);
    sendJson(response, 502, { error: "feed failed" });
    return;
  }

  console.log(
    `flume: accepted event=${envelope.event} native_id=${envelope.native_id} subject=${envelope.subject}`,
  );
  sendJson(response, 202, { accepted: 1 });
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }
  const normalized = address.toLowerCase().startsWith("::ffff:")
    ? address.slice("::ffff:".length)
    : address;
  return normalized === "::1" || normalized.startsWith("127.");
}

async function handleActivation(
  config: Config,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let body: Buffer;
  try {
    body = await readBody(request);
  } catch (error) {
    if (error instanceof EmptyBodyError) {
      sendJson(response, 400, { error: "empty body" });
    } else if (error instanceof BodyTooLargeError) {
      sendJson(response, 413, { error: "body too large" }, true);
    } else {
      sendJson(response, 400, { error: "bad request" });
    }
    return;
  }

  let document: JsonObject;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const parsed: unknown = JSON.parse(text);
    if (!isJsonObject(parsed)) {
      sendJson(response, 400, { error: "payload must be a JSON object" });
      return;
    }
    document = parsed;
  } catch {
    sendJson(response, 400, { error: "invalid json" });
    return;
  }

  let activation: Activation;
  try {
    activation = Activation.fromDocument(document);
  } catch (error) {
    if (error instanceof ActivationError) {
      sendJson(response, 400, { error: error.message });
      return;
    }
    console.error("flume: activation validation failed");
    sendJson(response, 500, { error: "internal error" });
    return;
  }

  if (!activation.waitCondition().shouldWake) {
    sendJson(response, 202, { accepted: 0 });
    return;
  }
  if (!config.wakeAgent && !config.wakeUrl) {
    console.error(
      "flume: activation rejected: FLUME_HERDR_WAKE_AGENT or FLUME_HERDR_WAKE_URL is not set",
    );
    sendJson(response, 503, { error: "wake gate not configured" });
    return;
  }

  try {
    const timeoutMs = config.wakeTimeoutMs ?? DEFAULT_WAKE_TIMEOUT_MS;
    if (config.wakeAgent) {
      await dispatchHerdrPrompt(
        config.herdrBin ?? "herdr",
        config.wakeAgent,
        activation,
        timeoutMs,
        config.inboxAgent,
      );
    } else {
      await dispatchActivation(config.wakeUrl!, activation, timeoutMs);
    }
  } catch (error) {
    const detail = error instanceof WakeGateError ? error.message : String(error);
    console.error(`flume: wake gate failed: ${detail}`);
    sendJson(response, 502, { error: "wake gate failed" });
    return;
  }

  const target = config.wakeAgent
    ? `agent=${config.wakeAgent}`
    : `url=${config.wakeUrl}`;
  console.log(
    `flume: woke herdr ${target} newEntryCount=${activation.newEntryCount} latestEntryId=${activation.latestEntryId}`,
  );
  sendJson(response, 202, { accepted: 1 });
}

class EmptyBodyError extends Error {}
class BodyTooLargeError extends Error {}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;

    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (tooLarge) {
        return;
      }
      if (total > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buffer);
    });
    request.once("end", () => {
      if (tooLarge) {
        reject(new BodyTooLargeError());
      } else if (total === 0) {
        reject(new EmptyBodyError());
      } else {
        resolve(Buffer.concat(chunks, total));
      }
    });
    request.once("error", reject);
  });
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  close = false,
): void {
  const raw = Buffer.from(JSON.stringify(body), "utf8");
  const headers: Record<string, string | number> = {
    "Content-Type": "application/json",
    "Content-Length": raw.length,
  };
  if (close) {
    headers.Connection = "close";
    response.shouldKeepAlive = false;
  }
  response.writeHead(status, headers);
  response.end(raw);
}
