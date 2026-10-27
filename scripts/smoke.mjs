import assert from "node:assert/strict";
import http from "node:http";

import { KIND } from "../dist/src/activation.js";
import { createFlumeServer } from "../dist/src/core.js";

const wakeRequests = [];
const wakeGate = http.createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    wakeRequests.push({
      method: request.method,
      path: request.url,
      mode: request.headers["x-flume-activation-mode"],
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    response.writeHead(204);
    response.end();
  });
});
await listen(wakeGate);

const wakePort = wakeGate.address().port;
const config = {
  bind: "127.0.0.1",
  port: 0,
  sourceId: "src_local_smoke",
  secrets: { github: "local-smoke-token" },
  wakeUrl: `http://127.0.0.1:${wakePort}/wake`,
  wakeTimeoutMs: 2_000,
};
const flume = createFlumeServer(config);
await listen(flume);

try {
  const baseUrl = `http://127.0.0.1:${flume.address().port}`;
  const valid = await postJson(baseUrl, {
    kind: KIND,
    activationId: "act-local-smoke",
    agentId: "herdr-local-smoke",
    newEntryCount: 2,
    latestEntryId: "entry-local-smoke",
    summary: "2 new GitHub events",
  });
  assert.equal(valid.status, 202);
  assert.deepEqual(valid.body, { accepted: 1 });
  console.log(
    `[1] valid activation: status=202 accepted:1 body=${JSON.stringify(valid.body)}`,
  );

  await waitFor(() => wakeRequests.length === 1);
  const received = wakeRequests[0];
  assert.equal(received.method, "POST");
  assert.equal(received.path, "/wake");
  assert.equal(received.mode, "activation_only");
  assert.deepEqual(received.body, {
    kind: KIND,
    newEntryCount: 2,
    latestEntryId: "entry-local-smoke",
    summary: "2 new GitHub events",
  });
  console.log(
    `[1] wake gate: POST ${received.path} X-Flume-Activation-Mode=${received.mode} body=${JSON.stringify(received.body)}`,
  );

  const withBody = await postJson(baseUrl, {
    kind: KIND,
    newEntryCount: 1,
    latestEntryId: "entry-local-smoke",
    summary: "body must not cross the wake boundary",
    entries: [{ entryId: "entry-local-smoke", body: "private inbox body" }],
  });
  assert.equal(withBody.status, 400);
  assert.match(String(withBody.body.error), /entries/);
  console.log(
    `[2] entries payload: 400 ${JSON.stringify(withBody.body)}`,
  );

  const empty = await postJson(baseUrl, {
    kind: KIND,
    newEntryCount: 0,
    latestEntryId: "entry-local-smoke",
    summary: "nothing new",
  });
  assert.equal(empty.status, 202);
  assert.deepEqual(empty.body, { accepted: 0 });
  assert.equal(wakeRequests.length, 1);
  console.log(
    `[3] empty activation: status=202 accepted:0 body=${JSON.stringify(empty.body)}`,
  );
  console.log(`[3] wake gate invocations: ${wakeRequests.length}`);

  const withoutWakeUrl = createFlumeServer({
    ...config,
    wakeUrl: undefined,
  });
  await listen(withoutWakeUrl);
  try {
    const noWakeBase = `http://127.0.0.1:${withoutWakeUrl.address().port}`;
    const noWake = await postJson(noWakeBase, {
      kind: KIND,
      newEntryCount: 1,
      latestEntryId: "entry-local-smoke",
      summary: "wake gate is not configured",
    });
    assert.equal(noWake.status, 503);
    assert.deepEqual(noWake.body, { error: "wake gate not configured" });
    console.log(`[4] no wake URL: 503 ${JSON.stringify(noWake.body)}`);
  } finally {
    await close(withoutWakeUrl);
  }

  console.log("smoke: passed");
} finally {
  await close(flume);
  await close(wakeGate);
}

async function postJson(baseUrl, body) {
  const response = await fetch(`${baseUrl}/activation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json(),
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("timed out waiting for the fake wake gate");
}
