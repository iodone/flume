import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

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
