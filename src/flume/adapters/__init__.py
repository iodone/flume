"""Adapter registry. One module per external system; core never grows a branch."""

from __future__ import annotations

from types import ModuleType

from . import gitlab

_MODULES: tuple[ModuleType, ...] = (gitlab,)


def all() -> tuple[ModuleType, ...]:
    return _MODULES


def get(name: str) -> ModuleType | None:
    for module in _MODULES:
        if module.NAME == name:
            return module
    return None
