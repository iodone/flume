import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import {
  Envelope,
  EnvelopeError,
  isJsonObject,
  parseTimestamp,
  type JsonObject,
} from "../envelope.js";

export const NAME = "gitlab";
export const SECRET_ENV = "FLUME_GITLAB_TOKEN";

const VERBS: Record<string, string> = {
  open: "opened",
  close: "closed",
  merge: "merged",
  reopen: "reopened",
  update: "updated",
  approve: "approved",
  unapprove: "unapproved",
};

export function verify(
  headers: IncomingHttpHeaders,
  _body: Buffer,
  secret: string | undefined,
): boolean {
  if (!secret) {
    return false;
  }
  const provided = header(headers, "x-gitlab-token") ?? "";
  const actual = Buffer.from(provided);
  const expected = Buffer.from(secret);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function normalize(
  headers: IncomingHttpHeaders,
  body: Buffer,
  document: JsonObject,
): Envelope {
  const kind = stringValue(document.object_kind) || slug(header(headers, "x-gitlab-event") ?? "");
  const attrs = isJsonObject(document.object_attributes)
    ? document.object_attributes
    : {};

  return new Envelope({
    native_id: nativeId(headers, body),
    event: eventName(kind, attrs),
    occurred_at: occurredAt(attrs),
    source: NAME,
    subject: subject(kind, document, attrs),
    payload: document,
  });
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function nativeId(headers: IncomingHttpHeaders, body: Buffer): string {
  for (const name of ["x-gitlab-event-uuid", "x-gitlab-webhook-uuid"]) {
    const value = header(headers, name)?.trim();
    if (value) {
      return value;
    }
  }
  return body.length === 0 ? "" : createHash("sha256").update(body).digest("hex");
}

function eventName(kind: string, attrs: JsonObject): string {
  const action = stringValue(attrs.action) || stringValue(attrs.state);
  if (kind === "merge_request") {
    return action
      ? `merge_request.${VERBS[action] ?? action}`
      : "merge_request.updated";
  }
  if (kind === "pipeline") {
    return `pipeline.${stringValue(attrs.status) || "updated"}`;
  }
  if (kind === "note") {
    return "note.created";
  }
  if (kind === "push") {
    return "push";
  }
  return `${kind}.received`;
}

function subject(kind: string, document: JsonObject, attrs: JsonObject): string {
  const projectPath = project(document);
  if (kind === "merge_request" && projectPath) {
    const iid = attrs.iid;
    if (iid !== undefined && iid !== null) {
      return `${projectPath}!${String(iid)}`;
    }
  } else if (kind === "pipeline" && projectPath) {
    const id = attrs.id;
    if (id !== undefined && id !== null) {
      return `${projectPath}#${String(id)}`;
    }
  } else if (kind === "note" && projectPath) {
    const noteable = stringValue(attrs.noteable_type);
    const target = noteable === "MergeRequest" ? document.merge_request : document.issue;
    const iid = isJsonObject(target) ? target.iid : undefined;
    if (iid !== undefined && iid !== null) {
      const separator = noteable === "MergeRequest" ? "!" : "#";
      return `${projectPath}${separator}${String(iid)}`;
    }
  }
  return projectPath || kind;
}

function project(document: JsonObject): string {
  const value = document.project;
  if (isJsonObject(value) && typeof value.path_with_namespace === "string") {
    return value.path_with_namespace;
  }
  return stringValue(document.path_with_namespace);
}

function occurredAt(attrs: JsonObject): string {
  for (const key of ["updated_at", "created_at", "finished_at", "timestamp"]) {
    const value = attrs[key];
    if (typeof value !== "string" || value.trim() === "") {
      continue;
    }
    try {
      return parseTimestamp(value);
    } catch (error) {
      if (!(error instanceof EnvelopeError)) {
        throw error;
      }
    }
  }
  return new Date()
    .toISOString()
    .replace(/\.\d{3}Z$/, "+00:00");
}

function slug(text: string): string {
  let value = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (value.endsWith("_hook")) {
    value = value.slice(0, -5);
  }
  return value || "unknown";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
