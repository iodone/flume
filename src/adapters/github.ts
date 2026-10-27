import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

import {
  Envelope,
  EnvelopeError,
  isJsonObject,
  parseTimestamp,
  type JsonObject,
} from "../envelope.js";

export const NAME = "github";
export const SECRET_ENV = "FLUME_GITHUB_SECRET";

export function verify(
  headers: IncomingHttpHeaders,
  body: Buffer,
  secret: string | undefined,
): boolean {
  if (!secret) {
    return false;
  }

  const sha256 = header(headers, "x-hub-signature-256")?.trim();
  if (sha256) {
    return safeEqual(
      sha256,
      `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    );
  }

  const sha1 = header(headers, "x-hub-signature")?.trim();
  if (sha1) {
    return safeEqual(
      sha1,
      `sha1=${createHmac("sha1", secret).update(body).digest("hex")}`,
    );
  }

  return false;
}

export function normalize(
  headers: IncomingHttpHeaders,
  body: Buffer,
  document: JsonObject,
): Envelope {
  const hook = header(headers, "x-github-event") ?? "unknown";
  const action = stringValue(document.action);

  return new Envelope({
    native_id: nativeId(headers, body),
    event: eventName(hook, action, document),
    occurred_at: occurredAt(hook, document),
    source: NAME,
    subject: subject(hook, document),
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

function safeEqual(provided: string, expected: string): boolean {
  const actual = Buffer.from(provided);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function nativeId(headers: IncomingHttpHeaders, body: Buffer): string {
  const delivery = header(headers, "x-github-delivery")?.trim();
  if (delivery) {
    return delivery;
  }
  return body.length === 0 ? "" : createHash("sha256").update(body).digest("hex");
}

function eventName(hook: string, action: string, document: JsonObject): string {
  const name = slug(hook);
  if (name === "pull_request") {
    const pullRequest = jsonObject(document.pull_request);
    if (action === "closed" && pullRequest?.merged === true) {
      return "pull_request.merged";
    }
    return action ? `pull_request.${action}` : "pull_request.received";
  }
  if (name === "issues") {
    return action ? `issue.${action}` : "issue.received";
  }
  if (name === "issue_comment") {
    return action ? `issue_comment.${action}` : "issue_comment.received";
  }
  if (name === "pull_request_review") {
    return action
      ? `pull_request_review.${action}`
      : "pull_request_review.received";
  }
  if (name === "pull_request_review_comment") {
    return action
      ? `pull_request_review_comment.${action}`
      : "pull_request_review_comment.received";
  }
  if (name === "workflow_run") {
    return action ? `workflow_run.${action}` : "workflow_run.received";
  }
  if (name === "push") {
    return "push";
  }
  return action ? `${name}.${action}` : `${name}.received`;
}

function subject(hook: string, document: JsonObject): string {
  const repository = repositoryName(document);
  const name = slug(hook);
  let target: JsonObject | undefined;

  if (name === "issues") {
    target = jsonObject(document.issue);
  } else if (name === "issue_comment") {
    target = jsonObject(document.issue);
  } else if (name === "workflow_run") {
    target = jsonObject(document.workflow_run);
  } else if (
    name === "pull_request" ||
    name === "pull_request_review" ||
    name === "pull_request_review_comment"
  ) {
    target = jsonObject(document.pull_request);
  }

  const number = targetNumber(target);
  return number ? `${repository}#${number}` : repository;
}

function repositoryName(document: JsonObject): string {
  const repository = jsonObject(document.repository);
  const fullName = repository?.full_name;
  if (typeof fullName === "string" && fullName.trim() !== "") {
    return fullName;
  }
  return "github";
}

function targetNumber(value: JsonObject | undefined): string {
  if (!value) {
    return "";
  }
  const number = value.number ?? value.id;
  return number === undefined || number === null ? "" : String(number);
}

function occurredAt(hook: string, document: JsonObject): string {
  const name = slug(hook);
  const candidates: unknown[] = [];

  if (name === "push") {
    const head = jsonObject(document.head_commit);
    candidates.push(head?.timestamp);
  }

  const target = targetObject(name, document);
  if (target) {
    candidates.push(target.updated_at, target.submitted_at, target.created_at);
  }

  const repository = jsonObject(document.repository);
  candidates.push(repository?.pushed_at);

  for (const value of candidates) {
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

  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

function targetObject(name: string, document: JsonObject): JsonObject | undefined {
  if (name === "issues") {
    return jsonObject(document.issue);
  }
  if (name === "issue_comment" || name === "pull_request_review_comment") {
    return jsonObject(document.comment);
  }
  if (name === "pull_request_review") {
    return jsonObject(document.review);
  }
  if (name === "workflow_run") {
    return jsonObject(document.workflow_run);
  }
  if (name === "pull_request") {
    return jsonObject(document.pull_request);
  }
  return undefined;
}

function jsonObject(value: unknown): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "unknown"
  );
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}
