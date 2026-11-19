import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createFlumeServer, type Config } from "../src/core.js";

const TOKEN = "e2e-gitlab-token";

// A native intake client: flume runs this executable, which forwards the envelope
// to a native intake HTTP endpoint. This is the same contract as `collie intake`.
function nativeClient(port: number): { command: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "flume-e2e-"));
  const script = path.join(dir, "native-intake.sh");
  writeFileSync(script, `#!/bin/sh
curl -sS -X POST "http://127.0.0.1:${port}/v1/ingress" \\
  -H 'content-type: application/json' --data-binary @-
`);
  chmodSync(script, 0o755);
  return { command: script, dir };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("GitLab webhook -> flume envelope -> native client intake", async () => {
  // A throwaway GitLab project checkout: the event's repository and the delivery path are separate.
  const project = mkdtempSync(path.join(tmpdir(), "flume-gitlab-project-"));
  execFileSync("git", ["init", "-q"], { cwd: project });
  writeFileSync(path.join(project, "README.md"), "# e2e project\n");

  let received:
    | { path?: string; body?: Record<string, unknown> }
    | undefined;
  const intake = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received = { path: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
      response.writeHead(202, { "content-type": "application/json" });
      response.end('{"accepted":true}');
    });
  });
  const intakePort = await listen(intake);
  const client = nativeClient(intakePort);

  const config: Config = {
    bind: "127.0.0.1",
    port: 0,
    sourceId: "",
    adapters: ["gitlab"],
    secrets: { gitlab: TOKEN },
    feedExec: client.command,
    feedTimeoutMs: 5_000,
  };
  const flume = createFlumeServer(config);
  const flumePort = await listen(flume);

  try {
    const payload = JSON.stringify({
      object_kind: "merge_request",
      project: { path_with_namespace: "group/project" },
      object_attributes: {
        iid: 123,
        action: "open",
        title: "e2e review",
        url: "https://gitlab.example/group/project/-/merge_requests/123",
        updated_at: "2026-11-19 12:00:00 UTC",
      },
    });
    const response = await new Promise<{ status: number }>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1", port: flumePort, path: "/gitlab", method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(payload),
          "x-gitlab-token": TOKEN,
          "x-gitlab-event": "Merge Request Hook",
          "x-gitlab-event-uuid": "e2e-native-intake-1",
        },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
      });
      req.on("error", reject);
      req.end(payload);
    });
    assert.equal(response.status, 202);
    assert.equal(received?.path, "/v1/ingress");
    assert.deepEqual(received?.body, {
      native_id: "e2e-native-intake-1",
      event: "merge_request.opened",
      occurred_at: "2026-11-19T12:00:00+00:00",
      source: "gitlab",
      subject: "group/project!123",
      payload: JSON.parse(payload),
    });
  } finally {
    await close(flume);
    await close(intake);
    rmSync(project, { recursive: true, force: true });
    rmSync(client.dir, { recursive: true, force: true });
  }
});
