import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { environmentWithOptionalFile, parseEnvFile } from "../src/env.js";

test("parses comments, export prefixes, and quoted values", () => {
  assert.deepEqual(
    parseEnvFile(
      [
        "# deployment values",
        "FLUME_GITLAB_TOKEN=plain-value",
        'export QUOTED="value with spaces"',
        "SINGLE='another value'",
        "",
      ].join("\n"),
    ),
    {
      FLUME_GITLAB_TOKEN: "plain-value",
      QUOTED: "value with spaces",
      SINGLE: "another value",
    },
  );
});

test("loads a 600 env file without mutating the caller environment", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flume-env-"));
  const envPath = path.join(directory, "flume.env");
  const baseEnv: NodeJS.ProcessEnv = { HOME: directory, FLUME_ENV_FILE: envPath };

  try {
    await writeFile(envPath, "FLUME_GITLAB_TOKEN=file-secret\n", { mode: 0o600 });
    await chmod(envPath, 0o600);

    const loaded = await environmentWithOptionalFile(baseEnv);

    assert.equal(loaded.FLUME_GITLAB_TOKEN, "file-secret");
    assert.equal(baseEnv.FLUME_ENV_FILE, envPath);
    assert.equal(baseEnv.FLUME_GITLAB_TOKEN, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects an env file readable by group or others", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flume-env-"));
  const envPath = path.join(directory, "flume.env");

  try {
    await writeFile(envPath, "FLUME_GITLAB_TOKEN=file-secret\n", { mode: 0o600 });
    await chmod(envPath, 0o644);

    await assert.rejects(
      environmentWithOptionalFile({ FLUME_ENV_FILE: envPath }),
      /permissions 600/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit environment takes precedence over the env file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "flume-env-"));
  const envPath = path.join(directory, "flume.env");

  try {
    await writeFile(envPath, "FLUME_PORT=1000\nFLUME_BIND=file-host\n", { mode: 0o600 });
    await chmod(envPath, 0o600);

    const loaded = await environmentWithOptionalFile({
      FLUME_ENV_FILE: envPath,
      FLUME_PORT: "2000",
      FLUME_BIND: "shell-host",
    });

    assert.equal(loaded.FLUME_PORT, "2000");
    assert.equal(loaded.FLUME_BIND, "shell-host");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
