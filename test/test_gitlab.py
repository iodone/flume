"""Tests for the GitLab adapter and the flume HTTP pipeline."""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from flume import adapters  # noqa: E402
from flume.adapters import gitlab  # noqa: E402
from flume.core import Config, make_server  # noqa: E402
from flume.envelope import Envelope, EnvelopeError  # noqa: E402

SECRET = "s3cret-token"
TOKEN = "s3cret-token"

MR_HOOK = {
    "object_kind": "merge_request",
    "user": {"name": "Ada"},
    "project": {"path_with_namespace": "group/project"},
    "object_attributes": {
        "iid": 123,
        "action": "open",
        "state": "opened",
        "created_at": "2026-10-23 06:58:00 UTC",
        "updated_at": "2026-10-23 06:59:00 UTC",
    },
}

PIPELINE_HOOK = {
    "object_kind": "pipeline",
    "project": {"path_with_namespace": "group/project"},
    "object_attributes": {
        "id": 88,
        "status": "success",
        "created_at": "2026-10-23 06:50:00 UTC",
        "updated_at": "2026-10-23 06:51:30 UTC",
    },
}

NOTE_HOOK = {
    "object_kind": "note",
    "project": {"path_with_namespace": "group/project"},
    "object_attributes": {"id": 500, "noteable_type": "MergeRequest", "note": "LGTM"},
    "merge_request": {"iid": 123},
}

PUSH_HOOK = {
    "object_kind": "push",
    "project": {"path_with_namespace": "group/project"},
    "commits": [{"id": "abc"}],
}


def _body(document: dict) -> bytes:
    return json.dumps(document).encode("utf-8")


class EnvelopeTest(unittest.TestCase):
    def test_rejects_empty_subject(self) -> None:
        with self.assertRaises(EnvelopeError):
            Envelope("id", "merge_request.opened", "2026-10-23T07:00:00+08:00", "gitlab", "", {})

    def test_rejects_bad_timestamp(self) -> None:
        with self.assertRaises(EnvelopeError):
            Envelope("id", "push", "yesterday", "gitlab", "group/project", {})

    def test_normalizes_naive_timestamp_to_utc(self) -> None:
        envelope = Envelope("id", "push", "2026-10-23T07:00:00", "gitlab", "g/p", {})
        self.assertEqual(envelope.occurred_at, "2026-10-23T07:00:00+00:00")

    def test_metadata_carries_subject_and_source(self) -> None:
        envelope = Envelope("id", "push", "2026-10-23T07:00:00Z", "gitlab", "g/p", {})
        self.assertEqual(envelope.metadata(), {"subject": "g/p", "source": "gitlab"})


class GitlabVerifyTest(unittest.TestCase):
    def test_accepts_matching_token(self) -> None:
        self.assertTrue(gitlab.verify({"X-Gitlab-Token": TOKEN}, b"{}", SECRET))

    def test_rejects_wrong_token(self) -> None:
        self.assertFalse(gitlab.verify({"X-Gitlab-Token": "nope"}, b"{}", SECRET))

    def test_rejects_missing_token(self) -> None:
        self.assertFalse(gitlab.verify({}, b"{}", SECRET))

    def test_rejects_when_secret_unset(self) -> None:
        self.assertFalse(gitlab.verify({"X-Gitlab-Token": ""}, b"{}", None))


class GitlabNormalizeTest(unittest.TestCase):
    def test_merge_request_opened(self) -> None:
        headers = {"X-Gitlab-Event": "Merge Request Hook", "X-Gitlab-Event-UUID": "evt-1"}
        envelope = gitlab.normalize(headers, _body(MR_HOOK), MR_HOOK)
        self.assertEqual(envelope.native_id, "evt-1")
        self.assertEqual(envelope.event, "merge_request.opened")
        self.assertEqual(envelope.subject, "group/project!123")
        self.assertEqual(envelope.occurred_at, "2026-10-23T06:59:00+00:00")
        self.assertEqual(envelope.source, "gitlab")
        self.assertEqual(envelope.payload, MR_HOOK)

    def test_merge_request_merged_verb(self) -> None:
        document = json.loads(json.dumps(MR_HOOK))
        document["object_attributes"]["action"] = "merge"
        document["object_attributes"]["state"] = "merged"
        envelope = gitlab.normalize({"X-Gitlab-Event": "Merge Request Hook"}, b"x", document)
        self.assertEqual(envelope.event, "merge_request.merged")

    def test_merge_request_without_action_uses_state(self) -> None:
        document = json.loads(json.dumps(MR_HOOK))
        document["object_attributes"].pop("action")
        document["object_attributes"]["state"] = "closed"
        envelope = gitlab.normalize({}, b"x", document)
        self.assertEqual(envelope.event, "merge_request.closed")

    def test_pipeline(self) -> None:
        headers = {"X-Gitlab-Event": "Pipeline Hook", "X-Gitlab-Webhook-UUID": "evt-2"}
        envelope = gitlab.normalize(headers, _body(PIPELINE_HOOK), PIPELINE_HOOK)
        self.assertEqual(envelope.native_id, "evt-2")
        self.assertEqual(envelope.event, "pipeline.success")
        self.assertEqual(envelope.subject, "group/project#88")
        self.assertEqual(envelope.occurred_at, "2026-10-23T06:51:30+00:00")

    def test_note(self) -> None:
        headers = {"X-Gitlab-Event": "Note Hook"}
        envelope = gitlab.normalize(headers, _body(NOTE_HOOK), NOTE_HOOK)
        self.assertEqual(envelope.event, "note.created")
        self.assertEqual(envelope.subject, "group/project!123")

    def test_push(self) -> None:
        headers = {"X-Gitlab-Event": "Push Hook"}
        envelope = gitlab.normalize(headers, _body(PUSH_HOOK), PUSH_HOOK)
        self.assertEqual(envelope.event, "push")
        self.assertEqual(envelope.subject, "group/project")
        self.assertIsNotNone(datetime.fromisoformat(envelope.occurred_at).tzinfo)

    def test_unknown_hook_falls_back_to_received(self) -> None:
        document = {"object_kind": "issue", "project": {"path_with_namespace": "group/project"}}
        envelope = gitlab.normalize({"X-Gitlab-Event": "Issue Hook"}, b"x", document)
        self.assertEqual(envelope.event, "issue.received")
        self.assertEqual(envelope.subject, "group/project")

    def test_native_id_falls_back_to_body_digest(self) -> None:
        body = _body(MR_HOOK)
        first = gitlab.normalize({"X-Gitlab-Event": "Merge Request Hook"}, body, MR_HOOK)
        again = gitlab.normalize({"X-Gitlab-Event": "Merge Request Hook"}, body, MR_HOOK)
        other = gitlab.normalize({"X-Gitlab-Event": "Merge Request Hook"}, b"{}", MR_HOOK)
        self.assertEqual(first.native_id, again.native_id)
        self.assertRegex(first.native_id, r"^[0-9a-f]{64}$")
        self.assertNotEqual(first.native_id, other.native_id)


class HttpPipelineTest(unittest.TestCase):
    def setUp(self) -> None:
        self.cfg = Config(
            bind="127.0.0.1",
            port=0,
            source_id="src-123",
            agentinbox_bin="agentinbox",
            secrets={"gitlab": SECRET},
        )
        self.server = make_server(self.cfg)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}/gitlab"

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def post(self, body: bytes, headers: dict[str, str], path: str = "/gitlab") -> tuple[int, dict]:
        url = self.url.rsplit("/", 1)[0] + path
        request = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as exc:
            with exc:
                return exc.code, json.loads(exc.read() or b"{}")

    def test_accepts_merge_request_hook_and_feeds_agentinbox(self) -> None:
        body = _body(MR_HOOK)
        headers = {
            "Content-Type": "application/json",
            "X-Gitlab-Token": TOKEN,
            "X-Gitlab-Event": "Merge Request Hook",
            "X-Gitlab-Event-UUID": "evt-abc",
        }
        with mock.patch("flume.feed.subprocess.run") as run:
            status, payload = self.post(body, headers)

        self.assertEqual(status, 202)
        self.assertEqual(payload, {"accepted": 1})
        run.assert_called_once()
        argv = run.call_args.args[0]
        self.assertEqual(
            argv[:4], ["agentinbox", "source", "event", "src-123"]
        )
        self.assertEqual(argv[argv.index("--native-id") + 1], "evt-abc")
        self.assertEqual(argv[argv.index("--event") + 1], "merge_request.opened")
        self.assertEqual(
            argv[argv.index("--occurred-at") + 1], "2026-10-23T06:59:00+00:00"
        )
        self.assertEqual(
            json.loads(argv[argv.index("--metadata-json") + 1]),
            {"subject": "group/project!123", "source": "gitlab"},
        )
        self.assertEqual(
            json.loads(argv[argv.index("--payload-json") + 1]), MR_HOOK
        )
        self.assertEqual(run.call_args.kwargs["check"], True)

    def test_rejects_bad_token(self) -> None:
        headers = {"X-Gitlab-Token": "wrong", "X-Gitlab-Event": "Merge Request Hook"}
        with mock.patch("flume.feed.subprocess.run") as run:
            status, payload = self.post(_body(MR_HOOK), headers)
        self.assertEqual(status, 401)
        self.assertEqual(payload, {"error": "invalid token"})
        run.assert_not_called()

    def test_rejects_non_json_body(self) -> None:
        headers = {"X-Gitlab-Token": TOKEN, "X-Gitlab-Event": "Merge Request Hook"}
        with mock.patch("flume.feed.subprocess.run") as run:
            status, payload = self.post(b"not json at all", headers)
        self.assertEqual(status, 400)
        self.assertEqual(payload, {"error": "invalid json"})
        run.assert_not_called()

    def test_reports_feed_failure_as_502(self) -> None:
        headers = {
            "X-Gitlab-Token": TOKEN,
            "X-Gitlab-Event": "Merge Request Hook",
            "X-Gitlab-Event-UUID": "evt-abc",
        }
        failure = subprocess.CalledProcessError(1, ["agentinbox"], stderr="boom")
        with mock.patch("flume.feed.subprocess.run", side_effect=failure):
            status, payload = self.post(_body(MR_HOOK), headers)
        self.assertEqual(status, 502)
        self.assertEqual(payload, {"error": "feed failed"})

    def test_unknown_adapter_is_404(self) -> None:
        status, payload = self.post(b"{}", {}, path="/nope")
        self.assertEqual(status, 404)
        self.assertEqual(payload, {"error": "unknown adapter: nope"})

    def test_healthz(self) -> None:
        with urllib.request.urlopen(self.url.replace("/gitlab", "/healthz"), timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(json.loads(response.read()), {"ok": True})

    def test_registry_exposes_gitlab(self) -> None:
        self.assertIs(adapters.get("gitlab"), gitlab)


if __name__ == "__main__":
    unittest.main()
