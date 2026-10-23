import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import * as gitlab from "../src/adapters/gitlab.js";
import { Envelope } from "../src/envelope.js";

const SECRET = "s3cret-token";

const MR_HOOK = {
  object_kind: "merge_request",
  user: { name: "Ada" },
  project: { path_with_namespace: "group/project" },
  object_attributes: {
    iid: 123,
    action: "open",
    state: "opened",
    created_at: "2026-10-23 06:58:00 UTC",
    updated_at: "2026-10-23 06:59:00 UTC",
  },
};

function body(document: object): Buffer {
  return Buffer.from(JSON.stringify(document));
}

test("adapter exposes the four-symbol contract", () => {
  assert.equal(gitlab.NAME, "gitlab");
  assert.equal(gitlab.SECRET_ENV, "FLUME_GITLAB_TOKEN");
  assert.equal(typeof gitlab.verify, "function");
  assert.equal(typeof gitlab.normalize, "function");
});

test("normalizes merge_request.opened to the envelope contract", () => {
  const raw = body(MR_HOOK);
  const envelope = gitlab.normalize(
    {
      "x-gitlab-event": "Merge Request Hook",
      "x-gitlab-event-uuid": "evt-1",
    },
    raw,
    MR_HOOK,
  );

  assert.ok(envelope instanceof Envelope);
  assert.deepEqual(envelope.toJSON(), {
    native_id: "evt-1",
    event: "merge_request.opened",
    occurred_at: "2026-10-23T06:59:00+00:00",
    source: "gitlab",
    subject: "group/project!123",
    payload: MR_HOOK,
  });
});

test("native_id is stable across repeated deliveries", () => {
  const raw = body(MR_HOOK);
  const headers = { "x-gitlab-event": "Merge Request Hook" };
  const first = gitlab.normalize(headers, raw, MR_HOOK);
  const again = gitlab.normalize(headers, raw, MR_HOOK);
  const other = gitlab.normalize(headers, Buffer.from("{}"), MR_HOOK);

  assert.equal(first.native_id, again.native_id);
  assert.equal(first.native_id, createHash("sha256").update(raw).digest("hex"));
  assert.notEqual(first.native_id, other.native_id);
});

test("uses the GitLab action vocabulary and falls back to state", () => {
  const merged = structuredClone(MR_HOOK);
  merged.object_attributes.action = "merge";
  merged.object_attributes.state = "merged";
  assert.equal(
    gitlab.normalize({}, body(merged), merged).event,
    "merge_request.merged",
  );

  const closed = structuredClone(MR_HOOK);
  delete (closed.object_attributes as { action?: string }).action;
  closed.object_attributes.state = "closed";
  assert.equal(
    gitlab.normalize({}, body(closed), closed).event,
    "merge_request.closed",
  );
});

test("verifies the GitLab token exactly", () => {
  assert.equal(gitlab.verify({ "x-gitlab-token": SECRET }, Buffer.from("{}"), SECRET), true);
  assert.equal(gitlab.verify({ "x-gitlab-token": "wrong" }, Buffer.from("{}"), SECRET), false);
  assert.equal(gitlab.verify({}, Buffer.from("{}"), SECRET), false);
  assert.equal(gitlab.verify({ "x-gitlab-token": "" }, Buffer.from("{}"), undefined), false);
});
