import { execFile } from "node:child_process";

import { isJsonObject, type JsonObject } from "./envelope.js";

export const KIND = "agentinbox.activation";
export const ACTIVATION_MODE = "activation_only";
export const DEFAULT_WAKE_TIMEOUT_MS = 5_000;

const BODY_FIELDS = ["entries", "items"] as const;

export class ActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActivationError";
  }
}

export class WakeGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WakeGateError";
  }
}

export interface WaitConditionContract {
  waitFor: {
    kind: typeof KIND;
    newEntryCountAtLeast: 1;
  };
  newEntryCount: number;
  latestEntryId: string;
  summary: string;
  completeWhen: {
    kind: "inbox.ack";
    through: string;
  };
}

export class WaitCondition {
  readonly newEntryCount: number;
  readonly latestEntryId: string;
  readonly summary: string;

  constructor(newEntryCount: number, latestEntryId: string, summary: string) {
    this.newEntryCount = newEntryCount;
    this.latestEntryId = latestEntryId;
    this.summary = summary;
  }

  get shouldWake(): boolean {
    return this.newEntryCount > 0;
  }

  asContract(): WaitConditionContract {
    return {
      waitFor: { kind: KIND, newEntryCountAtLeast: 1 },
      newEntryCount: this.newEntryCount,
      latestEntryId: this.latestEntryId,
      summary: this.summary,
      completeWhen: { kind: "inbox.ack", through: this.latestEntryId },
    };
  }
}

export interface ActivationPayload {
  kind: typeof KIND;
  newEntryCount: number;
  latestEntryId: string;
  summary: string;
}

export class Activation {
  readonly newEntryCount: number;
  readonly latestEntryId: string;
  readonly summary: string;

  constructor(newEntryCount: number, latestEntryId: string, summary: string) {
    this.newEntryCount = newEntryCount;
    this.latestEntryId = latestEntryId;
    this.summary = summary;
  }

  static fromDocument(document: JsonObject): Activation {
    if (document.kind !== KIND) {
      throw new ActivationError(`kind must be ${JSON.stringify(KIND)}`);
    }
    for (const field of BODY_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(document, field)) {
        throw new ActivationError(
          `activation_only payload must not include ${JSON.stringify(field)}`,
        );
      }
    }

    const count = document.newEntryCount;
    if (
      typeof count !== "number" ||
      !Number.isInteger(count) ||
      count < 0
    ) {
      throw new ActivationError(
        "newEntryCount must be a non-negative integer",
      );
    }

    const latest = document.latestEntryId;
    if (typeof latest !== "string" || latest.trim() === "") {
      throw new ActivationError("latestEntryId is empty");
    }

    const summary = document.summary;
    if (typeof summary !== "string") {
      throw new ActivationError("summary must be a string");
    }

    return new Activation(count, latest.trim(), summary);
  }

  wakePayload(): ActivationPayload {
    return {
      kind: KIND,
      newEntryCount: this.newEntryCount,
      latestEntryId: this.latestEntryId,
      summary: this.summary,
    };
  }

  waitCondition(): WaitCondition {
    return new WaitCondition(
      this.newEntryCount,
      this.latestEntryId,
      this.summary,
    );
  }
}

export async function dispatchActivation(
  url: string,
  activation: Activation,
  timeoutMs: number = DEFAULT_WAKE_TIMEOUT_MS,
): Promise<void> {
  let target: URL;
  try {
    target = new URL(url.trim());
  } catch {
    throw new WakeGateError("wake gate URL must be an absolute HTTP(S) URL");
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new WakeGateError("wake gate URL must be an absolute HTTP(S) URL");
  }

  let response: Response;
  try {
    response = await fetch(target, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Flume-Activation-Mode": ACTIVATION_MODE,
      },
      body: JSON.stringify(activation.wakePayload()),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new WakeGateError("wake gate is unreachable");
  }

  if (!response.ok) {
    throw new WakeGateError(`wake gate returned HTTP ${response.status}`);
  }
  await response.body?.cancel().catch(() => undefined);
}

export function wakePrompt(
  activation: Activation,
  inboxAgent?: string,
  intakeSkill?: string,
): string {
  return [
    "A flume activation arrived for AgentInbox.",
    ...(inboxAgent ? [`agentId=${inboxAgent}`] : []),
    `newEntryCount=${activation.newEntryCount}`,
    `latestEntryId=${activation.latestEntryId}`,
    ...(intakeSkill ? [`intakeSkill=${intakeSkill}`] : []),
    "",
    "This is a wake signal, not the event body.",
    "1. Read the unacked inbox for agentId, at most 50 entries; record the last entryId you inspect.",
    ...(intakeSkill
      ? [`2. Follow ${intakeSkill}. It is the only policy for classification, dedupe, task changes, and ack.`]
      : ["2. Follow the configured intake policy for classification, dedupe, task changes, and ack."]),
    "3. Ack only through the last inspected entry; never `ack --all`.",
    "4. Reply with entries reviewed, tasks added/updated, entries acked, and anything ambiguous.",
  ].join("\n");
}

export async function dispatchWakeExec(
  bin: string,
  args: string[],
  activation: Activation,
  timeoutMs: number = DEFAULT_WAKE_TIMEOUT_MS,
  inboxAgent?: string,
  intakeSkill?: string,
): Promise<void> {
  const prompt = wakePrompt(activation, inboxAgent, intakeSkill);
  await new Promise<void>((resolve, reject) => {
    execFile(
      bin,
      [...args, prompt],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, _stdout, stderr) => {
        if (error) {
          const detail = stderr.trim().replace(/\s+/g, " ").slice(0, 500) ||
            error.message;
          reject(new WakeGateError(`wake exec failed: ${detail}`));
          return;
        }
        resolve();
      },
    );
  });
}

interface HcTerminal {
  address: string;
  state?: string;
}

export async function dispatchHerdrAssistant(
  bin: string,
  spaceId: string,
  activation: Activation,
  timeoutMs: number = DEFAULT_WAKE_TIMEOUT_MS,
  inboxAgent?: string,
  intakeSkill?: string,
): Promise<string> {
  const listing = await runHc(bin, ["ls", "--json"], timeoutMs);
  let terminals: HcTerminal[];
  try {
    const document: unknown = JSON.parse(listing);
    if (!isJsonObject(document) || !Array.isArray(document.terminals)) {
      throw new Error("terminals is missing");
    }
    terminals = document.terminals.filter(isJsonObject).map((terminal) => ({
      address: typeof terminal.address === "string" ? terminal.address : "",
      state: typeof terminal.state === "string" ? terminal.state : undefined,
    }));
  } catch {
    throw new WakeGateError("herdr assistant discovery failed: invalid hc ls JSON");
  }

  const inspected: string[] = [];
  for (const candidate of terminals) {
    if (candidate.state !== "live" || typeof candidate.address !== "string") {
      continue;
    }
    const detail = await runHc(bin, ["get", candidate.address, "--json"], timeoutMs);
    let labels: Record<string, unknown> = {};
    try {
      const document: unknown = JSON.parse(detail);
      if (!isJsonObject(document)) {
        throw new Error("terminal is not an object");
      }
      if (isJsonObject(document.labels)) {
        labels = document.labels;
      }
    } catch {
      throw new WakeGateError(
        `herdr assistant discovery failed: invalid hc get JSON for ${candidate.address}`,
      );
    }
    const role = typeof labels["herdr.role"] === "string"
      ? labels["herdr.role"]
      : "unknown";
    inspected.push(`${candidate.address} (role=${role})`);
    if (
      role === "coordinator" &&
      (labels["herdr.coordinator.space"] === spaceId ||
        labels["herdr.space"] === spaceId)
    ) {
      const prompt = wakePrompt(activation, inboxAgent, intakeSkill);
      await runHc(bin, ["send", candidate.address, prompt], timeoutMs);
      return candidate.address;
    }
  }

  throw new WakeGateError(
    `herdr assistant not found for space=${spaceId}; live terminals: ${inspected.join(", ") || "none"}`,
  );
}

async function runHc(
  bin: string,
  args: string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim().replace(/\s+/g, " ").slice(0, 500) ||
            error.message;
          reject(new WakeGateError(`hc ${args[0]} failed: ${detail}`));
          return;
        }
        resolve(stdout);
      },
    );
  });
}
