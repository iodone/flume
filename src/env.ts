import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { ConfigError } from "./core.js";

const ENV_FILE_VAR = "FLUME_ENV_FILE";
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Load a launchd-friendly env file without mutating process.env.
 *
 * The returned object is local to the flume process. This keeps a webhook
 * secret readable by flume without placing it in argv or the inherited
 * process environment.
 */
export async function environmentWithOptionalFile(
  env: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const configuredPath = env[ENV_FILE_VAR]?.trim();
  if (!configuredPath) {
    return env;
  }

  const envPath = path.resolve(configuredPath);
  let details;
  try {
    details = await stat(envPath);
  } catch {
    throw new ConfigError(`${ENV_FILE_VAR} cannot be read: ${envPath}`);
  }
  if (!details.isFile()) {
    throw new ConfigError(`${ENV_FILE_VAR} must point to a regular file: ${envPath}`);
  }
  if ((details.mode & 0o077) !== 0) {
    throw new ConfigError(`${ENV_FILE_VAR} must have permissions 600: ${envPath}`);
  }

  let text: string;
  try {
    text = await readFile(envPath, "utf8");
  } catch {
    throw new ConfigError(`${ENV_FILE_VAR} cannot be read: ${envPath}`);
  }

  return { ...parseEnvFile(text), ...env };
}

export function parseEnvFile(text: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  const lines = text.split(/\r?\n/);

  for (const [index, rawLine] of lines.entries()) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    if (line.startsWith("export ")) {
      line = line.slice("export ".length).trimStart();
    }

    const separator = line.indexOf("=");
    if (separator < 1) {
      throw new ConfigError(`${ENV_FILE_VAR} has an invalid assignment on line ${index + 1}`);
    }
    const key = line.slice(0, separator).trim();
    if (!KEY_PATTERN.test(key)) {
      throw new ConfigError(`${ENV_FILE_VAR} has an invalid key on line ${index + 1}`);
    }

    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value.includes("\0")) {
      throw new ConfigError(`${ENV_FILE_VAR} has a NUL byte on line ${index + 1}`);
    }
    parsed[key] = value;
  }

  return parsed;
}
