"""
DAGRunner — executes agents in topological order using Kahn's algorithm.
See: docs/01-dag-vs-linear.md
"""

from __future__ import annotations
import os
from collections import defaultdict, deque
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .blackboard import Blackboard
    from .base_agent import BaseAgent


class DAGRunner:
    def __init__(self):
        self._nodes: dict[str, dict] = {}  # id → {agent, input_from}
        self._edges: list[tuple[str, str]] = []

    def add_node(self, node_id: str, agent: "BaseAgent", input_from: list[str] = None) -> "DAGRunner":
        input_from = input_from or []
        self._nodes[node_id] = {"agent": agent, "input_from": input_from}
        for dep in input_from:
            self._edges.append((dep, node_id))
        return self

    def topological_order(self) -> list[str]:
        in_degree: dict[str, int] = {n: 0 for n in self._nodes}
        adj: dict[str, list[str]] = defaultdict(list)

        for src, dst in self._edges:
            adj[src].append(dst)
            in_degree[dst] += 1

        queue = deque(n for n, d in in_degree.items() if d == 0)
        order = []

        while queue:
            node = queue.popleft()
            order.append(node)
            for dep in adj[node]:
                in_degree[dep] -= 1
                if in_degree[dep] == 0:
                    queue.append(dep)

        if len(order) != len(self._nodes):
            raise ValueError("Cycle detected in agent dependency graph")

        return order

    async def run(self, blackboard: "Blackboard") -> None:
        order = self.topological_order()
        debug = os.getenv("LOG_LEVEL") == "debug"

        if debug:
            print(f"[dag] execution order: {' → '.join(order)}")

        for node_id in order:
            node = self._nodes[node_id]
            agent = node["agent"]
            input_from = node["input_from"]

            blackboard.set_status(node_id, "running")
            print(f"\n▶  {node_id}")

            try:
                context = blackboard.get_notes_for(input_from) if input_from else ""
                await agent.execute(blackboard, context)
                blackboard.set_status(node_id, "done")
                print(f"✓  {node_id}")
            except Exception as err:
                blackboard.set_status(node_id, "failed")
                print(f"✗  {node_id}: {err}")
                raise
