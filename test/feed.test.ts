import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http, { type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Envelope } from "../src/envelope.js";
import { feed, feedExec } from "../src/feed.js";

test("feed posts the AgentInbox unix-socket event shape", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flume-feed-"));
  const socketPath = path.join(directory, "agentinbox.sock");
  let captured:
    | { method?: string; url?: string; body: Record<string, unknown> }
    | undefined;

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      captured = {
        method: request.method,
        url: request.url,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
          string,
          unknown
        >,
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });

  try {
    const envelope = new Envelope({
      native_id: "evt-abc",
      event: "merge_request.opened",
      occurred_at: "2026-10-23T06:59:00+00:00",
      source: "gitlab",
      subject: "group/project!123",
      payload: { object_kind: "merge_request" },
    });
    await feed(envelope, { sourceId: "src-123", socketPath });

    assert.deepEqual(captured, {
      method: "POST",
      url: "/sources/src-123/events",
      body: {
        sourceNativeId: "evt-abc",
        eventVariant: "merge_request.opened",
        occurredAt: "2026-10-23T06:59:00+00:00",
        metadata: { subject: "group/project!123", source: "gitlab" },
        rawPayload: { object_kind: "merge_request" },
      },
    });
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test("feed exec writes the normalized envelope to the CLI's stdin", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flume-exec-"));
  const script = path.join(directory, "deliver.sh");
  const output = path.join(directory, "event.json");
  await writeFile(script, `#!/bin/sh\ncat > "$1"\n`, { mode: 0o755 });
  await chmod(script, 0o755);
  const envelope = new Envelope({
    native_id: "evt-exec",
    event: "note.created",
    occurred_at: "2026-11-19T11:30:00+00:00",
    source: "custom",
    subject: "anything",
    payload: { open: true },
  });
  try {
    await feedExec(envelope, `${script} ${output}`);
    assert.deepEqual(JSON.parse(await readFile(output, "utf8")), envelope.toJSON());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
