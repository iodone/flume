"""Entry point: `python -m flume`."""

from __future__ import annotations

import logging
import sys

from . import adapters
from .core import Config, ConfigError, make_server

log = logging.getLogger("flume")


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    try:
        cfg = Config.from_env()
    except ConfigError as exc:
        log.error("%s", exc)
        return 2

    server = make_server(cfg)
    log.info(
        "listening on %s:%s -> agentinbox source %s (adapters: %s)",
        cfg.bind,
        server.server_address[1],
        cfg.source_id,
        ", ".join(m.NAME for m in adapters.all()),
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info("stopping")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
