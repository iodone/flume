import assert from "node:assert/strict";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  MAX_BODY_BYTES,
  configFromEnv,
  createFlumeServer,
  isLoopbackAddress,
  type Config,
  type FeedFunction,
} from "../src/core.js";
import type { Envelope } from "../src/envelope.js";
import { FeedError } from "../src/feed.js";

const SECRET = "s3cret-token";

const MR_HOOK = {
  object_kind: "merge_request",
  project: { path_with_namespace: "group/project" },
  object_attributes: {
    iid: 123,
    action: "open",
    state: "opened",
    updated_at: "2026-10-23 06:59:00 UTC",
  },
};

const CONFIG: Config = {
  bind: "127.0.0.1",
  port: 0,
  sourceId: "src-123",
  secrets: { gitlab: SECRET },
};

test("configFromEnv enables only the requested adapters", () => {
  const github = configFromEnv({
    AGENTINBOX_SOURCE_ID: "src-1",
    FLUME_ADAPTERS: "github",
    FLUME_GITHUB_SECRET: "gh-secret",
  });
  assert.deepEqual(github.adapters, ["github"]);
  assert.deepEqual(github.secrets, { github: "gh-secret" });

  const both = configFromEnv({
    AGENTINBOX_SOURCE_ID: "src-1",
    FLUME_ADAPTERS: "github,gitlab",
    FLUME_GITHUB_SECRET: "gh-secret",
    FLUME_GITLAB_TOKEN: "gl-token",
  });
  assert.deepEqual(both.adapters, ["github", "gitlab"]);

  assert.throws(
    () =>
      configFromEnv({
        AGENTINBOX_SOURCE_ID: "src-1",
        FLUME_ADAPTERS: "github",
      }),
    /FLUME_GITHUB_SECRET/,
  );
});

interface Response {
  status: number;
  body: Record<string, unknown>;
}

async function withServer(
  feedFn: FeedFunction,
  run: (post: (body: string | Buffer, headers?: Record<string, string>) => Promise<Response>) => Promise<void>,
): Promise<void> {
  const server = createFlumeServer(CONFIG, feedFn);
  await listen(server);
  const { port } = server.address() as AddressInfo;

  const post = (
    requestBody: string | Buffer,
    headers: Record<string, string> = {},
  ): Promise<Response> =>
    request(port, {
      method: "POST",
      path: "/gitlab",
      body: requestBody,
      headers,
    });

  try {
    await run(post);
  } finally {
    await close(server);
  }
}

test("POST /gitlab returns 202 and feeds the normalized envelope", async () => {
  let captured: { envelope: Envelope; sourceId: string } | undefined;
  const fakeFeed: FeedFunction = (envelope, options) => {
    captured = { envelope, sourceId: options.sourceId };
  };

  await withServer(fakeFeed, async (post) => {
    const response = await post(JSON.stringify(MR_HOOK), {
      "Content-Type": "application/json",
      "X-Gitlab-Token": SECRET,
      "X-Gitlab-Event": "Merge Request Hook",
      "X-Gitlab-Event-UUID": "evt-abc",
    });

    assert.equal(response.status, 202);
    assert.deepEqual(response.body, { accepted: 1 });
  });

  assert.ok(captured);
  assert.equal(captured.sourceId, "src-123");
  assert.deepEqual(captured.envelope.toJSON(), {
    native_id: "evt-abc",
    event: "merge_request.opened",
    occurred_at: "2026-10-23T06:59:00+00:00",
    source: "gitlab",
    subject: "group/project!123",
    payload: MR_HOOK,
  });
});

test("rejects a wrong token with 401 and never feeds", async () => {
  let called = false;
  await withServer(
    () => {
      called = true;
    },
    async (post) => {
      const response = await post(JSON.stringify(MR_HOOK), {
        "X-Gitlab-Token": "wrong",
        "X-Gitlab-Event": "Merge Request Hook",
      });
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, { error: "invalid token" });
    },
  );
  assert.equal(called, false);
});

test("rejects non-JSON with 400", async () => {
  let called = false;
  await withServer(
    () => {
      called = true;
    },
    async (post) => {
      const response = await post("not json", {
        "X-Gitlab-Token": SECRET,
        "X-Gitlab-Event": "Merge Request Hook",
      });
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, { error: "invalid json" });
    },
  );
  assert.equal(called, false);
});

test("rejects a non-object JSON payload with 400", async () => {
  let called = false;
  await withServer(
    () => {
      called = true;
    },
    async (post) => {
      const response = await post("[]", {
        "X-Gitlab-Token": SECRET,
        "X-Gitlab-Event": "Merge Request Hook",
      });
      assert.equal(response.status, 400);
      assert.deepEqual(response.body, { error: "payload must be a JSON object" });
    },
  );
  assert.equal(called, false);
});

test("maps AgentInbox feed failure to 502", async () => {
  await withServer(
    () => {
      throw new FeedError("AgentInbox refused the event");
    },
    async (post) => {
      const response = await post(JSON.stringify(MR_HOOK), {
        "X-Gitlab-Token": SECRET,
        "X-Gitlab-Event": "Merge Request Hook",
      });
      assert.equal(response.status, 502);
      assert.deepEqual(response.body, { error: "feed failed" });
    },
  );
});

test("rejects bodies over 8MB with 413", async () => {
  let called = false;
  const server = createFlumeServer(CONFIG, () => {
    called = true;
  });
  await listen(server);
  const { port } = server.address() as AddressInfo;
  try {
    const oversized = Buffer.alloc(MAX_BODY_BYTES + 1, "x");
    const response = await request(port, {
      method: "POST",
      path: "/gitlab",
      body: oversized,
      headers: {
        "X-Gitlab-Token": SECRET,
      },
    });
    assert.equal(response.status, 413);
    assert.deepEqual(response.body, { error: "body too large" });
  } finally {
    await close(server);
  }
  assert.equal(called, false);
});

test("recognizes only loopback addresses", () => {
  assert.equal(isLoopbackAddress("127.0.0.1"), true);
  assert.equal(isLoopbackAddress("127.2.3.4"), true);
  assert.equal(isLoopbackAddress("::1"), true);
  assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
  assert.equal(isLoopbackAddress("10.224.202.16"), false);
  assert.equal(isLoopbackAddress("::ffff:10.224.202.16"), false);
  assert.equal(isLoopbackAddress(undefined), false);
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

function request(
  port: number,
  options: {
    method: string;
    path: string;
    body?: string | Buffer;
    headers?: Record<string, string>;
  },
): Promise<Response> {
  return new Promise((resolve, reject) => {
    let responseStarted = false;
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      },
      (response) => {
        responseStarted = true;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
          });
        });
        response.on("error", reject);
      },
    );
    request.on("error", (error) => {
      // A 413 response may close the connection while the client is still
      // uploading the oversized body. The response itself is the assertion target.
      if (!responseStarted) {
        reject(error);
      }
    });
    if (options.body !== undefined) {
      request.end(options.body);
    } else {
      request.end();
    }
  });
}
