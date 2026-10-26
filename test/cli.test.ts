import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import net, { type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureAgentInbox } from "../src/cli.js";

test("flume start exits 2 when required configuration is missing", async () => {
  const cli = path.resolve("dist/src/cli.js");
  const child = spawn(process.execPath, [cli, "start"], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const code = await new Promise<number | null>((resolve) => {
    child.once("close", resolve);
  });

  assert.equal(code, 2);
  assert.match(stderr, /AGENTINBOX_SOURCE_ID/);
  assert.match(stderr, /FLUME_GITLAB_TOKEN/);
  assert.doesNotMatch(stderr, /s3cret-token/);
});

test(
  "flume start creates AgentInbox state under a fresh HOME",
  { timeout: 20_000 },
  async () => {
    const cli = path.resolve("dist/src/cli.js");
    const home = await mkdtemp(path.join(tmpdir(), "flume-home-"));
    const child = spawn(process.execPath, [cli, "start"], {
      env: {
        PATH: process.env.PATH,
        HOME: home,
        AGENTINBOX_SOURCE_ID: "src-fresh-home",
        FLUME_GITLAB_TOKEN: "local-smoke-token",
        FLUME_BIND: "127.0.0.1",
        FLUME_PORT: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    const closed = new Promise<number | null>((resolve) => {
      child.once("close", resolve);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`flume did not start: ${stderr}`));
        }, 15_000);
        child.stdout.on("data", () => {
          if (stdout.includes("flume: listening on")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("error", reject);
        child.once("close", (code) => {
          reject(new Error(`flume exited ${code}: ${stderr}`));
        });
      });

      assert.match(stdout, /agentinbox started/);
      await stat(path.join(home, ".agentinbox", "agentinbox.sock"));
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
      }
      await closed;
      await rm(home, { recursive: true, force: true });
    }
  },
);

test("ensureAgentInbox attaches without spawning when autostart is disabled", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flume-socket-"));
  const socketPath = path.join(directory, "agentinbox.sock");
  const server = net.createServer((socket) => socket.end());
  await listen(server, socketPath);

  try {
    const daemon = await ensureAgentInbox(
      {
        AGENTINBOX_SOCKET: socketPath,
        FLUME_AGENTINBOX_AUTOSTART: "0",
      },
      { timeoutMs: 1_000 },
    );

    assert.equal(daemon.socketPath, socketPath);
    assert.equal(daemon.child, null);
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

test("ensureAgentInbox reports a missing launchd-managed daemon", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flume-socket-"));
  const socketPath = path.join(directory, "agentinbox.sock");

  try {
    await assert.rejects(
      ensureAgentInbox(
        {
          AGENTINBOX_SOCKET: socketPath,
          FLUME_AGENTINBOX_AUTOSTART: "0",
        },
        { timeoutMs: 250 },
      ),
      /FLUME_AGENTINBOX_AUTOSTART=0/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ensureAgentInbox waits for a launchd-managed daemon", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flume-socket-"));
  const socketPath = path.join(directory, "agentinbox.sock");
  const waiting = ensureAgentInbox(
    {
      AGENTINBOX_SOCKET: socketPath,
      FLUME_AGENTINBOX_AUTOSTART: "0",
    },
    { timeoutMs: 2_000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 200));

  const server = net.createServer((socket) => socket.end());
  await listen(server, socketPath);

  try {
    const daemon = await waiting;
    assert.equal(daemon.socketPath, socketPath);
    assert.equal(daemon.child, null);
  } finally {
    await close(server);
    await rm(directory, { recursive: true, force: true });
  }
});

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
