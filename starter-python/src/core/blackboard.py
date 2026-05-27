"""
Blackboard — centralized shared state for the agent pipeline.
Agents never mutate state directly. They call Blackboard methods.
notes[] is append-only. All changes emit an observable event.
"""

from __future__ import annotations
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable


@dataclass
class Note:
    agent: str
    content: str
    timestamp: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())


class BudgetExceededError(Exception):
    pass


class Blackboard:
    def __init__(self, goal: str):
        self.goal = goal
        self._notes: list[Note] = []
        self._artifacts: dict[str, Any] = {}
        self._costs: dict[str, float] = {}
        self._status: dict[str, str] = {}
        self._listeners: list[Callable] = []
        self._total_cost = 0.0
        self._budget = float(os.getenv("BUDGET_USD", "0.50"))

    # ── Read ──────────────────────────────────────────────────────────────────

    @property
    def notes(self) -> list[Note]:
        return list(self._notes)

    @property
    def artifacts(self) -> dict:
        return dict(self._artifacts)

    @property
    def total_cost(self) -> float:
        return self._total_cost

    def get_notes_for(self, agent_names: list[str]) -> str:
        relevant = [n for n in self._notes if n.agent in agent_names]
        return "\n\n".join(f"[{n.agent}]\n{n.content}" for n in relevant)

    # ── Write ─────────────────────────────────────────────────────────────────

    def append_note(self, agent_name: str, content: str) -> None:
        note = Note(agent=agent_name, content=content)
        self._notes.append(note)
        self._emit("note", {"agent": agent_name})

    def set_artifact(self, key: str, value: Any) -> None:
        self._artifacts[key] = value
        self._emit("artifact", {"key": key})

    def set_status(self, agent_name: str, status: str) -> None:
        self._status[agent_name] = status
        self._emit("status", {"agent": agent_name, "status": status})

    def record_cost(self, agent_name: str, usd: float) -> None:
        self._costs[agent_name] = self._costs.get(agent_name, 0.0) + usd
        self._total_cost += usd
        self._emit("cost", {"agent": agent_name, "usd": usd, "total": self._total_cost})

        if self._total_cost > self._budget:
            raise BudgetExceededError(
                f"Budget exceeded: ${self._total_cost:.4f} > ${self._budget}"
            )

    # ── Observability ─────────────────────────────────────────────────────────

    def on_event(self, listener: Callable) -> None:
        self._listeners.append(listener)

    def _emit(self, event_type: str, data: dict) -> None:
        event = {"timestamp": datetime.now(timezone.utc).isoformat(), "type": event_type, **data}
        for listener in self._listeners:
            listener(event)

    def summary(self) -> dict:
        return {
            "goal": self.goal,
            "agents": dict(self._status),
            "total_cost": f"${self._total_cost:.4f}",
            "notes_count": len(self._notes),
            "artifacts": list(self._artifacts.keys()),
        }
