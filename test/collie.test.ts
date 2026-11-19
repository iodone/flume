import assert from "node:assert/strict";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import { configFromEnv, createFlumeServer } from "../src/core.js";

const TOKEN = "gl-secret";
const HOOK = JSON.stringify({
  object_kind: "merge_request",
  project: { path_with_namespace: "group/project" },
  object_attributes: { iid: 7, action: "open", updated_at: "2026-11-19 10:00:00 UTC" },
});

test("Collie mode does not require AgentInbox or a wake target", () => {
  const config = configFromEnv({
    FLUME_ADAPTERS: "gitlab",
    FLUME_GITLAB_TOKEN: TOKEN,
    FLUME_COLLIE_SOURCE: "gitlab",
  });
  assert.equal(config.collie?.source, "gitlab");
  assert.match(config.collie?.socketPath ?? "", /collie\/service\.sock$/);
  assert.equal(config.sourceId, "");
});

test("Collie mode rejects ambiguous transports and requires a source", () => {
  const base = { FLUME_GITLAB_TOKEN: TOKEN, FLUME_ADAPTERS: "gitlab" };
  assert.throws(
    () => configFromEnv({ ...base, FLUME_COLLIE_URL: "http://127.0.0.1:1", FLUME_COLLIE_SOCKET: "/tmp/s" }),
    /FLUME_COLLIE_SOURCE is required/,
  );
  assert.throws(
    () => configFromEnv({ ...base, FLUME_COLLIE_SOURCE: "gitlab", FLUME_COLLIE_URL: "http://127.0.0.1:1", FLUME_COLLIE_SOCKET: "/tmp/s" }),
    /set only one/,
  );
});

test("normalized flume envelope is forwarded to Collie", async () => {
  const received: { path?: string; body?: Buffer; contentType?: string } = {};
  const sink = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.path = request.url;
      received.contentType = request.headers["content-type"] as string | undefined;
      received.body = Buffer.concat(chunks);
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await listen(sink);
  const { port } = sink.address() as AddressInfo;

  const flume = createFlumeServer({
    bind: "127.0.0.1",
    port: 0,
    sourceId: "",
    secrets: { gitlab: TOKEN },
    collie: { source: "flume", url: `http://127.0.0.1:${port}` },
  });
  await listen(flume);
  const { port: flumePort } = flume.address() as AddressInfo;

  try {
    const response = await request(flumePort, {
      method: "POST",
      path: "/gitlab",
      body: HOOK,
      headers: {
        "Content-Type": "application/json",
        "X-Gitlab-Token": TOKEN,
        "X-Gitlab-Event": "Merge Request Hook",
        "X-Gitlab-Event-UUID": "evt-7",
      },
    });
    assert.equal(response.status, 202);
  } finally {
    await close(flume);
    await close(sink);
  }

  assert.equal(received.path, "/v1/in/flume");
  assert.equal(received.contentType, "application/json");
  const envelope = JSON.parse(received.body!.toString("utf8"));
  assert.equal(envelope.source, "gitlab");
  assert.equal(envelope.event, "merge_request.opened");
  assert.equal(envelope.native_id, "evt-7");
  assert.deepEqual(envelope.payload, JSON.parse(HOOK));
});

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function request(
  port: number,
  options: { method: string; path: string; body: string; headers: Record<string, string> },
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port, method: options.method, path: options.path,
      headers: { ...options.headers, "content-length": Buffer.byteLength(options.body) },
    }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on("error", reject);
    req.end(options.body);
  });
}
