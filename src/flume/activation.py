"""Validate AgentInbox activations and forward them to the herdr wake gate.

AgentInbox owns inbox entries and computes ``latestEntryId`` only after a
subscription has materialized them. flume therefore receives the activation
as a webhook, strips anything that is not activation metadata, and posts one
stateless wake request to herdr.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Mapping
from urllib.parse import urlsplit

KIND = "agentinbox.activation"
ACTIVATION_MODE = "activation_only"
WAKE_TIMEOUT_SECONDS = 5.0

_BODY_FIELDS = ("entries", "items")


class ActivationError(ValueError):
    """The payload is not a valid activation-only AgentInbox notification."""


class WakeGateError(RuntimeError):
    """The herdr wake gate did not accept the activation."""


@dataclass(frozen=True)
class WaitCondition:
    """What wakes a run, and what has to be acknowledged for it to finish."""

    new_entry_count: int
    latest_entry_id: str
    summary: str

    @property
    def should_wake(self) -> bool:
        return self.new_entry_count > 0

    def as_contract(self) -> dict[str, Any]:
        return {
            "waitFor": {"kind": KIND, "newEntryCountAtLeast": 1},
            "newEntryCount": self.new_entry_count,
            "latestEntryId": self.latest_entry_id,
            "summary": self.summary,
            "completeWhen": {
                "kind": "inbox.ack",
                "through": self.latest_entry_id,
            },
        }


@dataclass(frozen=True)
class Activation:
    """The activation-only fields needed by the herdr wake gate."""

    new_entry_count: int
    latest_entry_id: str
    summary: str

    @classmethod
    def from_document(cls, document: Mapping[str, Any]) -> "Activation":
        if not isinstance(document, Mapping):
            raise ActivationError("activation payload must be a JSON object")
        if document.get("kind") != KIND:
            raise ActivationError(f"kind must be {KIND!r}")

        for field in _BODY_FIELDS:
            if field in document:
                raise ActivationError(
                    f"activation_only payload must not include {field!r}"
                )

        count = document.get("newEntryCount")
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise ActivationError("newEntryCount must be a non-negative integer")

        latest = document.get("latestEntryId")
        if not isinstance(latest, str) or not latest.strip():
            raise ActivationError("latestEntryId is empty")

        summary = document.get("summary")
        if not isinstance(summary, str):
            raise ActivationError("summary must be a string")

        return cls(
            new_entry_count=count,
            latest_entry_id=latest.strip(),
            summary=summary,
        )

    def wake_payload(self) -> dict[str, Any]:
        """Return the canonical activation-only body sent to herdr."""
        return {
            "kind": KIND,
            "newEntryCount": self.new_entry_count,
            "latestEntryId": self.latest_entry_id,
            "summary": self.summary,
        }

    def wait_condition(self) -> WaitCondition:
        return WaitCondition(
            new_entry_count=self.new_entry_count,
            latest_entry_id=self.latest_entry_id,
            summary=self.summary,
        )


def dispatch_activation(
    url: str,
    activation: Activation,
    *,
    timeout: float = WAKE_TIMEOUT_SECONDS,
) -> None:
    """POST one activation-only payload to the herdr wake gate."""
    target = url.strip()
    parsed = urlsplit(target)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise WakeGateError("wake gate URL must be an absolute HTTP(S) URL")

    raw = json.dumps(
        activation.wake_payload(),
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    request = urllib.request.Request(
        target,
        data=raw,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-Flume-Activation-Mode": ACTIVATION_MODE,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.getcode()
            if not 200 <= status < 300:
                raise WakeGateError(f"wake gate returned HTTP {status}")
    except urllib.error.HTTPError as exc:
        raise WakeGateError(f"wake gate returned HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise WakeGateError("wake gate is unreachable") from exc
