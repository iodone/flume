const NONEMPTY_FIELDS = ["native_id", "event", "source", "subject"] as const;

export type JsonObject = Record<string, unknown>;

export interface EnvelopeInit {
  native_id: string;
  event: string;
  occurred_at: string;
  source: string;
  subject: string;
  payload: JsonObject;
}

export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

export class Envelope {
  readonly native_id: string;
  readonly event: string;
  readonly occurred_at: string;
  readonly source: string;
  readonly subject: string;
  readonly payload: JsonObject;

  constructor(init: EnvelopeInit) {
    for (const field of NONEMPTY_FIELDS) {
      const value = init[field];
      if (typeof value !== "string" || value.trim() === "") {
        throw new EnvelopeError(`${field} is empty`);
      }
    }
    if (!isJsonObject(init.payload)) {
      throw new EnvelopeError("payload must be a JSON object");
    }

    this.native_id = init.native_id;
    this.event = init.event;
    this.occurred_at = parseTimestamp(init.occurred_at);
    this.source = init.source;
    this.subject = init.subject;
    this.payload = init.payload;
  }

  metadata(): { subject: string; source: string } {
    return { subject: this.subject, source: this.source };
  }

  toJSON(): EnvelopeInit {
    return {
      native_id: this.native_id,
      event: this.event,
      occurred_at: this.occurred_at,
      source: this.source,
      subject: this.subject,
      payload: this.payload,
    };
  }
}

export function parseTimestamp(value: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EnvelopeError("occurred_at is empty");
  }

  let text = value.trim();
  if (text.endsWith(" UTC")) {
    text = `${text.slice(0, -4)}+00:00`;
  }
  text = text.replace(/^(\d{4}-\d{2}-\d{2}) /, "$1T");
  if (!hasTimezone(text)) {
    text += "Z";
  }

  const millis = Date.parse(text);
  if (Number.isNaN(millis)) {
    throw new EnvelopeError(`occurred_at is not ISO8601: ${JSON.stringify(value)}`);
  }

  return new Date(millis)
    .toISOString()
    .replace(/\.000Z$/, "+00:00")
    .replace(/Z$/, "+00:00");
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasTimezone(value: string): boolean {
  return /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(value);
}
