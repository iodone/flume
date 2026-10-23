"""The one event shape flume emits. Adapters fold vendor payloads into it."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


class EnvelopeError(ValueError):
    """A vendor payload did not fold into a valid envelope."""


def parse_timestamp(value: str) -> str:
    """Return ISO8601 with an explicit offset; naive input is read as UTC."""
    if not isinstance(value, str) or not value.strip():
        raise EnvelopeError("occurred_at is empty")
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError as exc:
        raise EnvelopeError(f"occurred_at is not ISO8601: {value!r}") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.isoformat()


@dataclass(frozen=True)
class Envelope:
    """A single translated event: enough to identify, route, and locate it."""

    native_id: str
    event: str
    occurred_at: str
    source: str
    subject: str
    payload: dict[str, Any]

    def __post_init__(self) -> None:
        for name in ("native_id", "event", "source", "subject"):
            value = getattr(self, name)
            if not isinstance(value, str) or not value.strip():
                raise EnvelopeError(f"{name} is empty")
        if not isinstance(self.payload, dict):
            raise EnvelopeError("payload must be a JSON object")
        object.__setattr__(self, "occurred_at", parse_timestamp(self.occurred_at))

    def metadata(self) -> dict[str, str]:
        """The agentinbox metadata sidecar: where the event points, who sent it."""
        return {"subject": self.subject, "source": self.source}
