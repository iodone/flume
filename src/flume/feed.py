"""Feed one envelope into AgentInbox through its CLI.

Deliberately fire-once: a failed feed surfaces as an error to the caller, and
recovery is the upstream system's own delivery mechanism. Durability and
collapsing repeats belong to AgentInbox.
"""

from __future__ import annotations

import json
import subprocess

from .envelope import Envelope

TIMEOUT_SECONDS = 15


class FeedError(RuntimeError):
    """agentinbox did not accept the event."""


def build_command(
    envelope: Envelope, *, bin_name: str, source_id: str
) -> list[str]:
    return [
        bin_name,
        "source",
        "event",
        source_id,
        "--native-id",
        envelope.native_id,
        "--event",
        envelope.event,
        "--occurred-at",
        envelope.occurred_at,
        "--metadata-json",
        _json(envelope.metadata()),
        "--payload-json",
        _json(envelope.payload),
    ]


def feed(
    envelope: Envelope,
    *,
    bin_name: str,
    source_id: str,
    timeout: float = TIMEOUT_SECONDS,
) -> None:
    command = build_command(envelope, bin_name=bin_name, source_id=source_id)
    try:
        subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.CalledProcessError as exc:
        detail = " ".join((exc.stderr or "").split())[:300]
        raise FeedError(f"agentinbox exited {exc.returncode}: {detail}") from exc
    except subprocess.TimeoutExpired as exc:
        raise FeedError(f"agentinbox timed out after {timeout}s") from exc
    except OSError as exc:
        raise FeedError(f"cannot run {bin_name}: {exc}") from exc


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
