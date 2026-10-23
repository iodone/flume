"""Tests for AgentInbox activation forwarding and wait-table criteria."""

from __future__ import annotations

import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from flume.activation import Activation, KIND  # noqa: E402
from flume.core import Config, make_server  # noqa: E402


class CapturingWakeGate:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - stdlib naming
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length)
                owner.requests.append(
                    {
                        "method": "POST",
                        "path": self.path,
                        "headers": dict(self.headers.items()),
                        "body": json.loads(raw),
                    }
                )
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, fmt: str, *args: Any) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        host, port = self.server.server_address
        return f"http://{host}:{port}/wake"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class ActivationPipelineTest(unittest.TestCase):
    def setUp(self) -> None:
        self.wake_gate = CapturingWakeGate()
        self.cfg = Config(
            bind="127.0.0.1",
            port=0,
            source_id="src-123",
            agentinbox_bin="agentinbox",
            secrets={},
            wake_url=self.wake_gate.url,
        )
        self.flume = make_server(self.cfg)
        self.thread = threading.Thread(target=self.flume.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.flume.server_address[1]}/activation"

    def tearDown(self) -> None:
        self.flume.shutdown()
        self.flume.server_close()
        self.thread.join(timeout=5)
        self.wake_gate.close()

    def post(self, document: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        body = json.dumps(document).encode("utf-8")
        request = urllib.request.Request(
            self.url,
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status, json.loads(response.read())
        except urllib.error.HTTPError as exc:
            with exc:
                return exc.code, json.loads(exc.read() or b"{}")

    def test_posts_activation_only_payload_to_herdr_wake_gate(self) -> None:
        status, response = self.post(
            {
                "kind": KIND,
                "activationId": "act-1",
                "agentId": "herdr-agent",
                "newEntryCount": 2,
                "latestEntryId": "entry-42",
                "summary": "2 new GitLab events",
            }
        )

        self.assertEqual(status, 202)
        self.assertEqual(response, {"accepted": 1})
        self.assertEqual(len(self.wake_gate.requests), 1)
        received = self.wake_gate.requests[0]
        self.assertEqual(received["method"], "POST")
        self.assertEqual(received["path"], "/wake")
        self.assertEqual(
            received["body"],
            {
                "kind": KIND,
                "newEntryCount": 2,
                "latestEntryId": "entry-42",
                "summary": "2 new GitLab events",
            },
        )
        headers = {key.lower(): value for key, value in received["headers"].items()}
        self.assertEqual(headers["content-type"], "application/json")
        self.assertEqual(headers["x-flume-activation-mode"], "activation_only")

    def test_wait_condition_reads_activation_count_and_latest_entry(self) -> None:
        activation = Activation.from_document(
            {
                "kind": KIND,
                "newEntryCount": 3,
                "latestEntryId": "entry-77",
                "summary": "3 new events",
            }
        )

        condition = activation.wait_condition()
        self.assertTrue(condition.should_wake)
        self.assertEqual(condition.new_entry_count, 3)
        self.assertEqual(condition.latest_entry_id, "entry-77")
        self.assertEqual(
            condition.as_contract(),
            {
                "waitFor": {"kind": KIND, "newEntryCountAtLeast": 1},
                "newEntryCount": 3,
                "latestEntryId": "entry-77",
                "summary": "3 new events",
                "completeWhen": {"kind": "inbox.ack", "through": "entry-77"},
            },
        )

        no_entries = Activation.from_document(
            {
                "kind": KIND,
                "newEntryCount": 0,
                "latestEntryId": "entry-76",
                "summary": "nothing new",
            }
        )
        self.assertFalse(no_entries.wait_condition().should_wake)

    def test_rejects_activation_with_inbox_bodies(self) -> None:
        status, response = self.post(
            {
                "kind": KIND,
                "newEntryCount": 1,
                "latestEntryId": "entry-42",
                "summary": "1 new event",
                "entries": [{"id": "entry-42", "body": "not for the wake gate"}],
            }
        )

        self.assertEqual(status, 400)
        self.assertIn("entries", response["error"])
        self.assertEqual(self.wake_gate.requests, [])


if __name__ == "__main__":
    unittest.main()
