"""HTTP front door: verify -> normalize -> feed. Nothing else happens here."""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit

from . import adapters
from .envelope import EnvelopeError
from .feed import FeedError, feed

log = logging.getLogger("flume")

MAX_BODY_BYTES = 8 * 1024 * 1024


class ConfigError(ValueError):
    """Required environment configuration is missing."""


@dataclass(frozen=True)
class Config:
    bind: str
    port: int
    source_id: str
    agentinbox_bin: str
    secrets: Mapping[str, str] = field(default_factory=dict)

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Config":
        env = os.environ if env is None else env
        missing = [
            name
            for name in ("AGENTINBOX_SOURCE_ID", *(m.SECRET_ENV for m in adapters.all()))
            if not env.get(name)
        ]
        if missing:
            raise ConfigError("missing env: " + ", ".join(missing))
        return cls(
            bind=env.get("FLUME_BIND") or "127.0.0.1",
            port=int(env.get("FLUME_PORT") or "9420"),
            source_id=env["AGENTINBOX_SOURCE_ID"],
            agentinbox_bin=env.get("AGENTINBOX_BIN") or "agentinbox",
            secrets={m.NAME: env[m.SECRET_ENV] for m in adapters.all()},
        )


class FlumeHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        cfg: Config,
        feed_fn: Callable[..., None],
        address: tuple[str, int],
    ) -> None:
        self.cfg = cfg
        self.feed_fn = feed_fn
        super().__init__(address, Handler)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "flume/0.1"

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        if urlsplit(self.path).path == "/healthz":
            self._reply(200, {"ok": True})
        else:
            self._reply(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802 - stdlib naming
        name = urlsplit(self.path).path.strip("/")
        adapter = adapters.get(name)
        if adapter is None:
            # Body left unread: close so the next request is not parsed out of it.
            self._reply(404, {"error": f"unknown adapter: {name or '/'}"}, close=True)
            return

        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._reply(400, {"error": "empty body"})
            return
        if length > MAX_BODY_BYTES:
            self._reply(413, {"error": "body too large"}, close=True)
            return
        body = self.rfile.read(length)

        secret = self.server.cfg.secrets.get(adapter.NAME)
        if not adapter.verify(self.headers, body, secret):
            log.warning("reject %s: bad token from %s", adapter.NAME, self.address_string())
            self._reply(401, {"error": "invalid token"})
            return

        try:
            document = json.loads(body)
        except (UnicodeDecodeError, ValueError):
            self._reply(400, {"error": "invalid json"})
            return
        if not isinstance(document, dict):
            self._reply(400, {"error": "payload must be a JSON object"})
            return

        try:
            envelope = adapter.normalize(self.headers, body, document)
        except EnvelopeError as exc:
            self._reply(400, {"error": str(exc)})
            return

        try:
            self.server.feed_fn(
                envelope,
                bin_name=self.server.cfg.agentinbox_bin,
                source_id=self.server.cfg.source_id,
            )
        except FeedError as exc:
            log.error("feed failed for %s: %s", envelope.event, exc)
            self._reply(502, {"error": "feed failed"})
            return

        log.info(
            "accepted %s event=%s subject=%s native_id=%s",
            adapter.NAME,
            envelope.event,
            envelope.subject,
            envelope.native_id,
        )
        self._reply(202, {"accepted": 1})

    def _reply(self, status: int, body: dict[str, Any], close: bool = False) -> None:
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        if close:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        self.wfile.write(raw)

    def log_message(self, fmt: str, *args: Any) -> None:
        log.info("%s %s", self.address_string(), fmt % args)


def make_server(
    cfg: Config, feed_fn: Callable[..., None] = feed
) -> FlumeHTTPServer:
    return FlumeHTTPServer(cfg, feed_fn, (cfg.bind, cfg.port))
