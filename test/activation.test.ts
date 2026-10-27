import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http, { type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  Activation,
  KIND,
  type ActivationPayload,
} from "../src/activation.js";
import { createFlumeServer, type Config } from "../src/core.js";

const CONFIG: Config = {
  bind: "127.0.0.1",
  port: 0,
  sourceId: "src-123",
  secrets: { gitlab: "s3cret-token" },
};

interface WakeRequest {
  method?: string;
  path?: string;
  headers: IncomingHttpHeaders;
  body: ActivationPayload;
}

interface Response {
  status: number;
  body: Record<string, unknown>;
}

test("posts the four-field activation_only payload to the herdr wake gate", async () => {
  const requests: WakeRequest[] = [];
  const wakeGate = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method,
        path: request.url,
        headers: request.headers,
        body: JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as ActivationPayload,
      });
      response.writeHead(204);
      response.end();
    });
  });
  await listen(wakeGate);

  const wakePort = (wakeGate.address() as AddressInfo).port;
  const flume = createFlumeServer({
    ...CONFIG,
    wakeUrl: `http://127.0.0.1:${wakePort}/wake`,
    wakeTimeoutMs: 2_000,
  });
  await listen(flume);

  try {
    const port = (flume.address() as AddressInfo).port;
    const response = await post(port, "/activation", {
      kind: KIND,
      activationId: "act-1",
      agentId: "herdr-agent",
      newEntryCount: 2,
      latestEntryId: "entry-42",
      summary: "2 new GitLab events",
    });

    assert.equal(response.status, 202);
    assert.deepEqual(response.body, { accepted: 1 });
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.method, "POST");
    assert.equal(requests[0]?.path, "/wake");
    assert.deepEqual(requests[0]?.body, {
      kind: KIND,
      newEntryCount: 2,
      latestEntryId: "entry-42",
      summary: "2 new GitLab events",
    });
    assert.equal(requests[0]?.headers["content-type"], "application/json");
    assert.equal(requests[0]?.headers.accept, "application/json");
    assert.equal(
      requests[0]?.headers["x-flume-activation-mode"],
      "activation_only",
    );
  } finally {
    await close(flume);
    await close(wakeGate);
  }
});

test("maps activation fields to wait-table criteria", () => {
  const activation = Activation.fromDocument({
    kind: KIND,
    newEntryCount: 3,
    latestEntryId: "entry-77",
    summary: "3 new events",
  });

  const condition = activation.waitCondition();
  assert.equal(condition.shouldWake, true);
  assert.equal(condition.newEntryCount, 3);
  assert.equal(condition.latestEntryId, "entry-77");
  assert.deepEqual(condition.asContract(), {
    waitFor: { kind: KIND, newEntryCountAtLeast: 1 },
    newEntryCount: 3,
    latestEntryId: "entry-77",
    summary: "3 new events",
    completeWhen: { kind: "inbox.ack", through: "entry-77" },
  });

  const empty = Activation.fromDocument({
    kind: KIND,
    newEntryCount: 0,
    latestEntryId: "entry-76",
    summary: "nothing new",
  });
  assert.equal(empty.waitCondition().shouldWake, false);
});

test("does not call the wake gate for an empty activation", async () => {
  let calls = 0;
  const wakeGate = http.createServer((_request, response) => {
    calls += 1;
    response.writeHead(204);
    response.end();
  });
  await listen(wakeGate);
  const wakePort = (wakeGate.address() as AddressInfo).port;

  const flume = createFlumeServer({
    ...CONFIG,
    wakeUrl: `http://127.0.0.1:${wakePort}/wake`,
  });
  await listen(flume);

  try {
    const port = (flume.address() as AddressInfo).port;
    const response = await post(port, "/activation", {
      kind: KIND,
      newEntryCount: 0,
      latestEntryId: "entry-76",
      summary: "nothing new",
    });
    assert.equal(response.status, 202);
    assert.deepEqual(response.body, { accepted: 0 });
    assert.equal(calls, 0);
  } finally {
    await close(flume);
    await close(wakeGate);
  }
});

test("rejects activation payloads carrying inbox bodies", async () => {
  let calls = 0;
  const wakeGate = http.createServer((_request, response) => {
    calls += 1;
    response.writeHead(204);
    response.end();
  });
  await listen(wakeGate);
  const wakePort = (wakeGate.address() as AddressInfo).port;

  const flume = createFlumeServer({
    ...CONFIG,
    wakeUrl: `http://127.0.0.1:${wakePort}/wake`,
  });
  await listen(flume);

  try {
    const port = (flume.address() as AddressInfo).port;
    const response = await post(port, "/activation", {
      kind: KIND,
      newEntryCount: 1,
      latestEntryId: "entry-42",
      summary: "1 new event",
      entries: [{ id: "entry-42", body: "not for the wake gate" }],
    });
    assert.equal(response.status, 400);
    assert.match(String(response.body.error), /entries/);
    assert.equal(calls, 0);
  } finally {
    await close(flume);
    await close(wakeGate);
  }
});

test("maps wake-gate rejection to 502", async () => {
  const wakeGate = http.createServer((_request, response) => {
    response.writeHead(500, { "Content-Type": "application/json" });
    response.end('{"error":"boom"}');
  });
  await listen(wakeGate);
  const wakePort = (wakeGate.address() as AddressInfo).port;

  const flume = createFlumeServer({
    ...CONFIG,
    wakeUrl: `http://127.0.0.1:${wakePort}/wake`,
  });
  await listen(flume);

  try {
    const port = (flume.address() as AddressInfo).port;
    const response = await post(port, "/activation", {
      kind: KIND,
      newEntryCount: 1,
      latestEntryId: "entry-42",
      summary: "1 new event",
    });
    assert.equal(response.status, 502);
    assert.deepEqual(response.body, { error: "wake gate failed" });
  } finally {
    await close(flume);
    await close(wakeGate);
  }
});

test("returns 503 when a wake is needed but no wake gate is configured", async () => {
  const flume = createFlumeServer(CONFIG);
  await listen(flume);

  try {
    const port = (flume.address() as AddressInfo).port;
    const response = await post(port, "/activation", {
      kind: KIND,
      newEntryCount: 1,
      latestEntryId: "entry-42",
      summary: "1 new event",
    });
    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: "wake gate not configured" });
  } finally {
    await close(flume);
  }
});

test("calls herdr agent prompt directly when wakeAgent is configured", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flume-herdr-"));
  const argsFile = join(directory, "args.txt");
  const herdrBin = join(directory, "herdr");
  await writeFile(
    herdrBin,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\n`,
    { mode: 0o755 },
  );

  const flume = createFlumeServer({
    ...CONFIG,
    wakeAgent: "sw-coordinator",
    inboxAgent: "herdr-main",
    herdrBin,
    wakeTimeoutMs: 2_000,
  });
  await listen(flume);

  try {
    const port = (flume.address() as AddressInfo).port;
    const response = await post(port, "/activation", {
      kind: KIND,
      newEntryCount: 1,
      latestEntryId: "entry-42",
      summary: "1 new event",
    });

    assert.equal(response.status, 202);
    assert.deepEqual(response.body, { accepted: 1 });
    const args = await readFile(argsFile, "utf8");
    assert.match(args, /^agent\nprompt\nsw-coordinator\n/);
    assert.match(args, /agentId=herdr-main/);
    assert.match(args, /newEntryCount=1/);
    assert.match(args, /Process this activation now/);
    assert.match(args, /standing authorization/);
    assert.match(args, /herdr-projects tasks/);
    assert.match(args, /follow workflow-dsx/);
    assert.match(args, /never use `ack --all`/);
    assert.doesNotMatch(args, /Reply exactly/);
  } finally {
    await close(flume);
    await rm(directory, { recursive: true, force: true });
  }
});

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function post(
  port: number,
  path: string,
  document: Record<string, unknown>,
): Promise<Response> {
  const raw = JSON.stringify(document);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(raw),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
              string,
              unknown
            >,
          });
        });
      },
    );
    request.once("error", reject);
    request.end(raw);
  });
}
