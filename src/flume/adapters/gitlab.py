"""GitLab webhook adapter: check X-Gitlab-Token, fold the payload into an Envelope."""

from __future__ import annotations

import hashlib
import hmac
import re
from datetime import datetime
from typing import Any, Mapping

from ..envelope import Envelope, EnvelopeError, parse_timestamp

NAME = "gitlab"
SECRET_ENV = "FLUME_GITLAB_TOKEN"

# GitLab's action/state vocabulary -> the verbs subscriptions filter on.
_VERBS = {
    "open": "opened",
    "close": "closed",
    "merge": "merged",
    "reopen": "reopened",
    "update": "updated",
    "approve": "approved",
    "unapprove": "unapproved",
}


def verify(headers: Mapping[str, str], body: bytes, secret: str | None) -> bool:
    if not secret:
        return False
    provided = _header(headers, "X-Gitlab-Token") or ""
    return hmac.compare_digest(provided, secret)


def normalize(
    headers: Mapping[str, str], body: bytes, document: dict[str, Any]
) -> Envelope:
    kind = str(
        document.get("object_kind") or _slug(_header(headers, "X-Gitlab-Event") or "")
    )
    attrs = document.get("object_attributes")
    if not isinstance(attrs, dict):
        attrs = {}
    return Envelope(
        native_id=_native_id(headers, body),
        event=_event(kind, attrs),
        occurred_at=_occurred_at(attrs),
        source=NAME,
        subject=_subject(kind, document, attrs),
        payload=document,
    )


def _header(headers: Mapping[str, str], name: str) -> str | None:
    value = headers.get(name)
    if value is not None:
        return value
    wanted = name.lower()
    for key, candidate in headers.items():
        if key.lower() == wanted:
            return candidate
    return None


def _native_id(headers: Mapping[str, str], body: bytes) -> str:
    """Prefer GitLab's delivery UUID; fall back to the body digest so the same
    payload keeps its id when the sender delivers it again."""
    for name in ("X-Gitlab-Event-UUID", "X-Gitlab-Webhook-UUID"):
        value = (_header(headers, name) or "").strip()
        if value:
            return value
    if not body:
        return ""
    return hashlib.sha256(body).hexdigest()


def _event(kind: str, attrs: dict[str, Any]) -> str:
    if kind == "merge_request":
        verb = attrs.get("action") or attrs.get("state")
        return f"merge_request.{_VERBS.get(verb, verb)}" if verb else "merge_request.updated"
    if kind == "pipeline":
        return f"pipeline.{attrs.get('status') or 'updated'}"
    if kind == "note":
        return "note.created"
    if kind == "push":
        return "push"
    return f"{kind}.received"


def _subject(kind: str, document: dict[str, Any], attrs: dict[str, Any]) -> str:
    path = _project_path(document)
    if kind == "merge_request" and path:
        iid = attrs.get("iid")
        if iid is not None:
            return f"{path}!{iid}"
    elif kind == "pipeline" and path:
        pipeline_id = attrs.get("id")
        if pipeline_id is not None:
            return f"{path}#{pipeline_id}"
    elif kind == "note" and path:
        noteable = attrs.get("noteable_type")
        target = document.get("merge_request" if noteable == "MergeRequest" else "issue")
        iid = target.get("iid") if isinstance(target, dict) else None
        if iid is not None:
            separator = "!" if noteable == "MergeRequest" else "#"
            return f"{path}{separator}{iid}"
    return path or kind


def _project_path(document: dict[str, Any]) -> str:
    project = document.get("project")
    if isinstance(project, dict) and project.get("path_with_namespace"):
        return str(project["path_with_namespace"])
    if document.get("path_with_namespace"):
        return str(document["path_with_namespace"])
    return ""


def _occurred_at(attrs: dict[str, Any]) -> str:
    for key in ("updated_at", "created_at", "finished_at", "timestamp"):
        raw = attrs.get(key)
        if not isinstance(raw, str) or not raw.strip():
            continue
        text = raw.strip()
        if text.endswith(" UTC"):  # GitLab's Rails-style timestamp
            text = text[:-4] + "+00:00"
        try:
            return parse_timestamp(text)
        except EnvelopeError:
            continue
    return datetime.now().astimezone().isoformat(timespec="seconds")


def _slug(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")
    if slug.endswith("_hook"):
        slug = slug[: -len("_hook")]
    return slug or "unknown"
