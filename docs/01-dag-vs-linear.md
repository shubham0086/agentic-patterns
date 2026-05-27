# Pattern 01 — DAG vs Linear Chains for Agent Pipelines

## The problem

You have a multi-step agent pipeline. The naïve implementation is a linear chain:

```
Planner → Researcher → Coder → Tester → Reviewer
```

Each agent runs, passes its output to the next, and the pipeline completes. Simple to reason about, easy to implement, works for demos.

In production, it breaks in four distinct ways.

---

## Why linear chains fail

### 1. Dependency blindness
A linear chain enforces one total ordering. But in real pipelines, some agents don't depend on each other — they depend on a *common ancestor*. A Coder and a Tester both need the Architect's output, but the Coder doesn't need to wait for the Tester, and the Tester doesn't need to wait for the Coder. A linear chain serializes them anyway, doubling wall-clock time.

```
Linear (wrong):  Architect → Coder → Tester → Reviewer
                                  ^ Tester waits for Coder for no reason

DAG (correct):   Architect → Coder   ─┐
                          → Tester  ─┤→ Reviewer
```

### 2. No re-entry
When the Reviewer fails a Coder output, a linear chain has no path back. You either restart the whole pipeline (expensive) or accept bad output. A DAG models the feedback loop explicitly:

```
Coder ↔ Auditor  (3 iterations)
  └─── passes ───→ Reviewer
```

### 3. Context explosion
Linear chains pass the entire accumulated context to every downstream agent. By the time the Reviewer runs, it receives the raw user goal + Planner notes + Researcher dump + full Coder output + Tester report. Token count explodes. Cost explodes. Quality degrades because the model drowns in irrelevant context.

A DAG node reads only from its declared inputs — not the entire pipeline history.

### 4. Brittle error handling
When node 3 of 7 fails in a linear chain, you either fail the whole pipeline or skip forward. A DAG lets you define failure behavior per node: retry locally, skip to fallback node, or abort only the affected branch.

---

## The pattern

Represent agents as nodes and their dependencies as edges in a Directed Acyclic Graph. Execute using a **topological sort** — specifically Kahn's algorithm — which guarantees:
- Nodes run only after all their dependencies complete
- Independent nodes can run in parallel (or be scheduled optimally in serial)
- Cycle detection at definition time, not runtime

### Kahn's algorithm (the core of any DAG executor)

```python
from collections import defaultdict, deque

def topological_order(nodes: list, edges: list[tuple]) -> list:
    """
    nodes: list of node IDs
    edges: list of (from_node, to_node) — "from must run before to"
    returns: nodes in valid execution order
    """
    in_degree = defaultdict(int)
    adjacency = defaultdict(list)

    for u, v in edges:
        adjacency[u].append(v)
        in_degree[v] += 1
        in_degree.setdefault(u, 0)

    # Start with all nodes that have no dependencies
    queue = deque([n for n in nodes if in_degree[n] == 0])
    order = []

    while queue:
        node = queue.popleft()
        order.append(node)
        for dependent in adjacency[node]:
            in_degree[dependent] -= 1
            if in_degree[dependent] == 0:
                queue.append(dependent)

    if len(order) != len(nodes):
        raise ValueError("Cycle detected in agent dependency graph")

    return order
```

### Node state contract

Each node reads from a typed state object and writes back to it:

```python
@dataclass
class NodeState:
    goal: str                          # original user goal — never mutated
    notes: list[str]                   # append-only — each agent adds, never replaces
    artifacts: dict[str, str]          # file paths to generated artifacts
    status: dict[str, NodeStatus]      # per-node: pending | running | done | failed

def run_node(node_id: str, state: NodeState) -> NodeState:
    # Agent reads what it needs from state
    # Agent appends its output to state.notes or state.artifacts
    # Agent never touches another agent's notes
    return state
```

The append-only `notes` list is the key invariant. Agents accumulate knowledge; they don't overwrite each other's work.

### Defining the graph

```python
pipeline = DAG(
    nodes=["planner", "researcher", "architect", "coder", "auditor", "documenter"],
    edges=[
        ("planner",    "researcher"),
        ("planner",    "architect"),
        ("researcher", "architect"),
        ("architect",  "coder"),
        ("architect",  "auditor"),
        ("coder",      "auditor"),   # auditor reviews coder's output
        ("auditor",    "documenter"),
    ]
)

order = topological_order(pipeline.nodes, pipeline.edges)
# → ["planner", "researcher", "architect", "coder", "auditor", "documenter"]
```

---

## Trade-offs

**When DAG is better than linear**:
- 3+ agents with non-trivial dependencies
- Any pipeline with feedback loops (review → revise cycles)
- When parallel execution matters for wall-clock time

**When linear is fine**:
- 2-3 agents with a strict single chain and no branching
- Prototypes where correctness of execution matters more than performance
- When you can't afford to define the graph explicitly (rapid iteration)

**The cost of DAG**:
- You must define edges explicitly. This is overhead upfront but pays off at the third pipeline you build.
- Cycle detection must be correct. A bad cycle check means silent infinite loops.
- Parallel execution requires thread safety in the state object. If you parallelize, use immutable state + merge pattern, not shared mutable state.

---

## Context isolation — the underrated benefit

A linear chain's context explosion is not just a cost problem — it's a quality problem. Giving an agent irrelevant context degrades its output.

The DAG pattern enforces context isolation naturally: you control exactly which previous outputs a node receives. The Tester gets the Architect's spec and the Coder's output — not the Researcher's 4000-token web scrape.

Practical implementation: instead of passing the full `notes` list, pass only the notes from declared input nodes:

```python
def get_node_context(node_id: str, graph: DAG, state: NodeState) -> str:
    input_nodes = graph.get_predecessors(node_id)
    relevant_notes = [state.notes[n] for n in input_nodes if n in state.notes]
    return "\n\n".join(relevant_notes)
```

This alone can cut token usage 40-60% on a 6-agent pipeline.

---

## Where this came from

This pattern is used in:
- **Agentic-SDLC** — the Researcher → Architect → [Coder ↔ Auditor]×3 → Documenter pipeline
- **ACE App Builder** — 6-agent build pipeline with topological ordering
- **Agency OS** — 6-agent marketing pipeline with branch execution

The topological sort implementation above is production code from Agentic-SDLC, simplified for clarity.

---

*Next: [Pattern 02 — Multi-Provider LLM Routing](02-multi-provider-llm-routing.md)*
