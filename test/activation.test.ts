import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http, { type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  Activation,
  dispatchHerdrAssistant,
  dispatchWakeExec,
  wakePrompt,
  KIND,
  WakeGateError,
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

test("supports a generic CLI command with agent arguments", async () => {
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
    wakeExec: `${herdrBin} agent prompt sw-coordinator`,
    inboxAgent: "herdr-main",
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
    assert.match(args, /latestEntryId=entry-42/);
    assert.match(args, /Follow the workflow-event-intake skill/);
    assert.match(args, /wake signal, not the event body/);
    assert.match(args, /at most 50 entries/);
    assert.match(args, /never `ack --all`/);
    assert.doesNotMatch(args, /herdr-projects/);
    assert.doesNotMatch(args, /workflow-dsx/);
    assert.doesNotMatch(args, /Reply exactly/);
  } finally {
    await close(flume);
    await rm(directory, { recursive: true, force: true });
  }
});

test("wakes only the live Assistant whose labels match the configured space", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flume-hc-"));
  const { bin, callsFile, sendFile } = await fakeHc(directory, [
    {
      address: "t-other",
      labels: {
        "herdr.role": "coordinator",
        "herdr.coordinator.space": "space-other",
      },
    },
    {
      address: "t-helper",
      labels: { "herdr.role": "helper", "herdr.space": "space-1" },
    },
    {
      address: "t-assistant",
      labels: {
        "herdr.role": "coordinator",
        "herdr.coordinator.space": "space-1",
      },
    },
    {
      address: "t-finished",
      state: "finished",
      labels: { "herdr.role": "coordinator", "herdr.space": "space-1" },
    },
  ]);
  const activation = new Activation(2, "entry-42", "2 new events");

  try {
    const address = await dispatchHerdrAssistant(
      bin,
      "space-1",
      activation,
      2_000,
      "inbox-agent",
    );

    assert.equal(address, "t-assistant");
    const sendArgs = (await readFile(sendFile, "utf8")).trimEnd().split("\n");
    assert.equal(sendArgs[0], "send");
    assert.equal(sendArgs[1], "t-assistant");
    assert.equal(
      sendArgs.slice(2).join("\n"),
      wakePrompt(activation, "inbox-agent"),
    );
    assert.match(sendArgs.slice(2).join("\n"), /newEntryCount=2/);
    assert.match(sendArgs.slice(2).join("\n"), /latestEntryId=entry-42/);
    assert.match(sendArgs.slice(2).join("\n"), /workflow-event-intake/);
    assert.equal(await readFile(callsFile, "utf8"), "ls\n--json\nget\nt-other\nget\nt-helper\nget\nt-assistant\nsend\nt-assistant\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not send when no live terminal is the Assistant for the space", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flume-hc-"));
  const { bin, callsFile } = await fakeHc(directory, [
    { address: "t-worker", labels: { "herdr.role": "helper" } },
  ]);

  try {
    await assert.rejects(
      dispatchHerdrAssistant(bin, "space-missing", new Activation(1, "entry-1", "new")),
      (error: unknown) => {
        assert.ok(error instanceof WakeGateError);
        assert.match(error.message, /space-missing/);
        assert.match(error.message, /t-worker \(role=helper\)/);
        return true;
      },
    );
    assert.equal(await readFile(callsFile, "utf8"), "ls\n--json\nget\nt-worker\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("routes Assistant config through the activation handler and logs its target", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flume-hc-"));
  const { bin, sendFile } = await fakeHc(directory, [
    {
      address: "t16",
      labels: { "herdr.role": "coordinator", "herdr.space": "space-1" },
    },
  ]);
  const flume = createFlumeServer({
    ...CONFIG,
    wakeExec: `${bin} space space-1`,
  });
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (message: string) => logs.push(message);
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
    assert.match(await readFile(sendFile, "utf8"), /^send\nt16\n/);
    assert.ok(logs.some((line) =>
      line.includes("woke exec=hc assistant=t16 space=space-1")
    ));
  } finally {
    console.log = originalLog;
    await close(flume);
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not treat a custom executable ending in hc as Assistant discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flume-myhc-"));
  const argsFile = join(directory, "args.txt");
  const bin = join(directory, "myhc");
  await writeFile(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\n`,
    { mode: 0o755 },
  );
  const flume = createFlumeServer({
    ...CONFIG,
    wakeExec: `${bin} space space-1`,
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
    const args = (await readFile(argsFile, "utf8")).trimEnd().split("\n");
    assert.deepEqual(args.slice(0, 2), ["space", "space-1"]);
    assert.match(args[2]!, /^A flume activation arrived for AgentInbox\./);
  } finally {
    await close(flume);
    await rm(directory, { recursive: true, force: true });
  }
});

test("passes the complete wake prompt to a generic CLI command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "flume-cli-"));
  const argsFile = join(directory, "args.txt");
  const bin = join(directory, "notify");
  await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\n`, { mode: 0o755 });
  const activation = new Activation(1, "entry-42", "1 new event");

  try {
    await dispatchWakeExec(
      bin,
      ["notify", "--target", "ops"],
      activation,
      2_000,
      "inbox-agent",
    );
    const args = (await readFile(argsFile, "utf8")).trimEnd().split("\n");
    assert.deepEqual(args.slice(0, 3), ["notify", "--target", "ops"]);
    assert.equal(args.slice(3).join("\n"), wakePrompt(activation, "inbox-agent"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

interface FakeTerminal {
  address: string;
  state?: string;
  labels: Record<string, string>;
}

async function fakeHc(
  directory: string,
  terminals: FakeTerminal[],
): Promise<{ bin: string; callsFile: string; sendFile: string }> {
  const bin = join(directory, "hc");
  const callsFile = join(directory, "calls.txt");
  const sendFile = join(directory, "send.txt");
  const cases = terminals.map((terminal) =>
    `    ${terminal.address}) printf '%s\\n' '${JSON.stringify({ address: terminal.address, labels: terminal.labels })}' ;;`,
  );
  await writeFile(
    bin,
    `#!/bin/sh
printf '%s\\n' "$1" "$2" >> "${callsFile}"
case "$1" in
  ls) printf '%s\\n' '${JSON.stringify({ terminals: terminals.map(({ address, state = "live" }) => ({ address, state })) })}' ;;
  get)
    case "$2" in
${cases.join("\n")}
    esac ;;
  send) printf '%s\\n' "$@" > "${sendFile}" ;;
esac
`,
    { mode: 0o755 },
  );
  return { bin, callsFile, sendFile };
}

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
