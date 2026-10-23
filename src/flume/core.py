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
from .activation import (
    Activation,
    ActivationError,
    WakeGateError,
    dispatch_activation,
)
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
    wake_url: str | None = None
    wake_timeout: float = 5.0

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
        try:
            wake_timeout = float(env.get("FLUME_HERDR_WAKE_TIMEOUT") or "5")
        except ValueError as exc:
            raise ConfigError("FLUME_HERDR_WAKE_TIMEOUT must be a number") from exc
        if wake_timeout <= 0:
            raise ConfigError("FLUME_HERDR_WAKE_TIMEOUT must be positive")
        return cls(
            bind=env.get("FLUME_BIND") or "127.0.0.1",
            port=int(env.get("FLUME_PORT") or "9420"),
            source_id=env["AGENTINBOX_SOURCE_ID"],
            agentinbox_bin=env.get("AGENTINBOX_BIN") or "agentinbox",
            secrets={m.NAME: env[m.SECRET_ENV] for m in adapters.all()},
            wake_url=(env.get("FLUME_HERDR_WAKE_URL") or "").strip() or None,
            wake_timeout=wake_timeout,
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
        path = urlsplit(self.path).path.strip("/")
        if path == "activation":
            self._handle_activation()
            return

        name = path
        adapter = adapters.get(name)
        if adapter is None:
            # Body left unread: close so the next request is not parsed out of it.
            self._reply(404, {"error": f"unknown adapter: {name or '/'}"}, close=True)
            return

        body = self._read_body()
        if body is None:
            return

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

    def _handle_activation(self) -> None:
        body = self._read_body()
        if body is None:
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
            activation = Activation.from_document(document)
        except ActivationError as exc:
            self._reply(400, {"error": str(exc)})
            return

        if not activation.wait_condition().should_wake:
            self._reply(202, {"accepted": 0})
            return

        wake_url = self.server.cfg.wake_url
        if not wake_url:
            log.error("activation rejected: FLUME_HERDR_WAKE_URL is not set")
            self._reply(503, {"error": "wake gate not configured"})
            return

        try:
            dispatch_activation(
                wake_url,
                activation,
                timeout=self.server.cfg.wake_timeout,
            )
        except WakeGateError as exc:
            log.error("wake gate failed: %s", exc)
            self._reply(502, {"error": "wake gate failed"})
            return

        log.info(
            "woke herdr new_entry_count=%s latest_entry_id=%s",
            activation.new_entry_count,
            activation.latest_entry_id,
        )
        self._reply(202, {"accepted": 1})

    def _read_body(self) -> bytes | None:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._reply(400, {"error": "empty body"})
            return None
        if length > MAX_BODY_BYTES:
            self._reply(413, {"error": "body too large"}, close=True)
            return None
        return self.rfile.read(length)

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
