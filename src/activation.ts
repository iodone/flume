import { execFile } from "node:child_process";

import type { JsonObject } from "./envelope.js";

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

export async function dispatchHerdrPrompt(
  bin: string,
  agent: string,
  activation: Activation,
  timeoutMs: number = DEFAULT_WAKE_TIMEOUT_MS,
): Promise<void> {
  const prompt = [
    "A flume activation arrived for AgentInbox.",
    `newEntryCount=${activation.newEntryCount}`,
    "Reply exactly `flume wake received` and stop. Do not modify files.",
  ].join("\n");

  await new Promise<void>((resolve, reject) => {
    execFile(
      bin,
      ["agent", "prompt", agent, prompt],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (error) => {
        if (error) {
          reject(new WakeGateError(`herdr prompt failed: ${error.message}`));
          return;
        }
        resolve();
      },
    );
  });
}
