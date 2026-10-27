import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import * as github from "../src/adapters/github.js";
import { Envelope } from "../src/envelope.js";

const SECRET = "github-webhook-secret";

const PULL_REQUEST_HOOK = {
  action: "opened",
  pull_request: {
    number: 42,
    merged: false,
    created_at: "2026-10-23T06:58:00Z",
    updated_at: "2026-10-23T06:59:00Z",
    user: { login: "ada" },
  },
  repository: {
    full_name: "owner/repo",
    pushed_at: "2026-10-23T06:57:00Z",
  },
  sender: { login: "ada" },
};

function body(document: object): Buffer {
  return Buffer.from(JSON.stringify(document));
}

function signature(raw: Buffer, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
}

test("adapter exposes the four-symbol contract", () => {
  assert.equal(github.NAME, "github");
  assert.equal(github.SECRET_ENV, "FLUME_GITHUB_SECRET");
  assert.equal(typeof github.verify, "function");
  assert.equal(typeof github.normalize, "function");
});

test("verifies a SHA-256 webhook signature", () => {
  const raw = body(PULL_REQUEST_HOOK);
  assert.equal(
    github.verify({ "x-hub-signature-256": signature(raw) }, raw, SECRET),
    true,
  );
  assert.equal(
    github.verify({ "x-hub-signature-256": signature(raw, "wrong") }, raw, SECRET),
    false,
  );
  assert.equal(github.verify({}, raw, SECRET), false);
  assert.equal(github.verify({ "x-hub-signature-256": signature(raw) }, raw, undefined), false);
});

test("normalizes pull_request.opened to the envelope contract", () => {
  const raw = body(PULL_REQUEST_HOOK);
  const envelope = github.normalize(
    {
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-1",
    },
    raw,
    PULL_REQUEST_HOOK,
  );

  assert.ok(envelope instanceof Envelope);
  assert.deepEqual(envelope.toJSON(), {
    native_id: "delivery-1",
    event: "pull_request.opened",
    occurred_at: "2026-10-23T06:59:00+00:00",
    source: "github",
    subject: "owner/repo#42",
    payload: PULL_REQUEST_HOOK,
  });
});

test("native_id is stable across repeated deliveries", () => {
  const raw = body(PULL_REQUEST_HOOK);
  const headers = { "x-github-event": "pull_request" };
  const first = github.normalize(headers, raw, PULL_REQUEST_HOOK);
  const again = github.normalize(headers, raw, PULL_REQUEST_HOOK);
  const other = github.normalize(headers, Buffer.from("{}"), PULL_REQUEST_HOOK);

  assert.equal(first.native_id, again.native_id);
  assert.equal(first.native_id, createHash("sha256").update(raw).digest("hex"));
  assert.notEqual(first.native_id, other.native_id);
});

test("maps a merged pull request to pull_request.merged", () => {
  const merged = structuredClone(PULL_REQUEST_HOOK);
  merged.action = "closed";
  merged.pull_request.merged = true;

  const envelope = github.normalize(
    { "x-github-event": "pull_request", "x-github-delivery": "delivery-2" },
    body(merged),
    merged,
  );

  assert.equal(envelope.event, "pull_request.merged");
  assert.equal(envelope.subject, "owner/repo#42");
});

test("maps a submitted review to feedback", () => {
  const review = {
    action: "submitted",
    review: {
      id: 99,
      state: "commented",
      submitted_at: "2026-10-23T07:10:00Z",
    },
    pull_request: { number: 42 },
    repository: { full_name: "owner/repo" },
  };

  const envelope = github.normalize(
    { "x-github-event": "pull_request_review", "x-github-delivery": "delivery-3" },
    body(review),
    review,
  );

  assert.equal(envelope.event, "pull_request_review.submitted");
  assert.equal(envelope.subject, "owner/repo#42");
  assert.equal(envelope.occurred_at, "2026-10-23T07:10:00+00:00");
});

test("maps an issue comment to the issue subject", () => {
  const comment = {
    action: "created",
    comment: {
      id: 7,
      created_at: "2026-10-23T07:20:00Z",
    },
    issue: { number: 15 },
    repository: { full_name: "owner/repo" },
  };

  const envelope = github.normalize(
    { "x-github-event": "issue_comment", "x-github-delivery": "delivery-4" },
    body(comment),
    comment,
  );

  assert.equal(envelope.event, "issue_comment.created");
  assert.equal(envelope.subject, "owner/repo#15");
});
