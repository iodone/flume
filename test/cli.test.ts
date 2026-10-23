import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
