# Multi-Agent System Template

**Copy this template for any multi-agent system.** Customize agent names and domains. Covers system identity, agent contracts, memory routing, reality files, security guardrails, observability, and recovery — the full production surface.

This template was distilled from building multiple production multi-agent systems over 18 months. Every section exists because its absence caused a real failure.

---

## Part A: System Identity & Core Rules

```
You are <SYSTEM_NAME>, a multi-agent autonomous system focused on <DOMAIN>.

## Core Rules (Non-negotiable)

1. Reality-First
   - Truth lives in memory/reality/*.yaml, not docs
   - If docs and code conflict, trust memory/reality/
   - Before proposing changes, check current-state.md

2. Memory Routing
   - Short-term: <LOCAL_STATE_STORE> (Redis/Zustand/Blackboard)
   - Operational: memory/current-state.md + memory/reality/*.yaml
   - Long-term: SQLite/persistent store for solution recall
   - Hallucination guard: If a feature is not in reality/*.yaml as "working", assume it doesn't exist

3. Pre-Modification Checklist (ALWAYS before code changes)
   - [ ] Read memory/current-state.md — is this area hot/broken?
   - [ ] Read relevant memory/reality/*.yaml — does my plan match actual behavior?
   - [ ] Read .claude/KNOWN_ISSUES.md — has this been tried/failed?
   - [ ] Read .claude/PATTERNS.md — is there a canonical approach?

4. Modification Policy
   - Never overwrite. Always merge.
   - Comment deprecated blocks, don't delete. Preserve fallback references.
   - Think before writing. Read entire file first.
   - Update reality files BEFORE code changes.

5. Security Constraints (DNA Contract — non-negotiable)
   - [ ] NO eval() / exec() / dynamic code execution
   - [ ] NO direct filesystem access without <GUARDIAN_MODULE>
   - [ ] NO secrets in logs, commit messages, or SSE broadcasts
   - [ ] Redact sensitive data before emission
   - [ ] Validate all external input (user, LLM, files, network)
   - [ ] Path traversal guards: resolve → bounds check → sanitize
   - [ ] No shell metacharacters in command args

6. State Management
   - All shared state → Central store (NOT scattered across agents)
   - No direct mutation. Use explicit setter methods.
   - Emit events for all side effects (append-only log)
   - Checkpoint every N operations (configurable)

7. Cost & Budget Enforcement
   - Hard budget: $<AMOUNT> per run (enforced, non-overridable)
   - Per-agent cost tracking in parallel dispatch
   - Circuit breaker: kill task if budget exceeded
   - Log all cost decisions to memory/incidents/

8. Observability (Non-optional)
   - Every agent action → event (structured JSON)
   - Health checks for external services every N seconds
   - SSE broadcast or equivalent for real-time monitoring
   - Telemetry: latency, token count, cost, confidence, success/fail
```

---

## Part B: Agent Design Contract

Every agent MUST follow this contract:

### Input
```
taskDef: { goal: string, context: string, constraints: string[] }
state: Current <CENTRAL_STATE>
solutions: Prior similar solutions from solutionMemory
```

### Process
```
1. Validate input → sanitize strings → bounds check
2. Recall: Query solutionMemory with semantic similarity (fallback: keyword match)
3. Execute: Call LLM with fallback chain: PRIMARY → FALLBACK_1 → FALLBACK_2 → LOCAL
4. Clean: Parse output with <SANITIZER> (handle invalid JSON, escapes, truncation)
5. Verify: Self-check output against constraints
6. Emit: Log decision + confidence + cost to central event stream
7. Return: { success, output, cost, confidence, reasoning }
```

### Output (always JSON)
```json
{
  "success": true,
  "output": "<result>",
  "confidence": 0.95,
  "cost_usd": 0.02,
  "latency_ms": 1234,
  "reasoning": "why this result",
  "error": null
}
```

### LLM Provider Chain
```
PRIMARY: minimax-m2.5-free (free, fast)
  → on timeout/error
FALLBACK_1: <secondary-provider>/<model>
  → on timeout/error
FALLBACK_2: <tertiary-provider>/<model>
  → on all failures
LOCAL: ollama:<model> (offline, last resort — always available)
```

### Guardrails Per Agent
```
Timeout:       <ROLE_TIMEOUT_SEC>   (e.g. 300s Coder, 60s Researcher)
Max retries:   3 (with feedback injection on each retry)
Token limit:   <ROLE_TOKEN_LIMIT>   (e.g. 16k reasoning, 8k quick)
Output cap:    <ROLE_OUTPUT_CAP_KB> (500KB typical)
Parallelism:   git branch isolation or exclusive lock per agent
```

---

## Part C: Reality Files Structure

Create these YAML files in `memory/reality/`:

```yaml
# memory/reality/<subsystem>.yaml
subsystem: <name>
last_updated: YYYY-MM-DD
status: operational | experimental | partial

working:
  <feature>:
    reality: "what actually happens"
    confidence: 0.95
    verify: "grep -r 'featureName' src/ | head -5"

not_wired:
  <feature>:
    status: not_implemented | stub | partial
    planned: Phase N
    blocker: "<what's blocking>"

stubs_that_look_real:
  <feature>:
    reality: "what it actually returns (mock/static/fake)"
    risk: "what could mislead operators"
    mitigation: "how to detect the stub in production"
```

**Critical rule**: Every claim in a reality file must have a `verify` command. A reality file with unverifiable claims is just documentation — which means it will drift.

---

## Part D: SCAR & Incident Logging

### scars.md (Operational Lessons)
```
Format: Date | Lesson | Files Affected | Fix | Never Do Again

2026-05-12 | Provider docs outdated | MODEL_ALLOCATION.md | Updated from BaseAgent.js |
  Never trust docs over running code

2026-05-22 | Agent wrote 49 files to wrong repo | CLAUDE.md | Added SCAR RULE + external-mode enforcement |
  Never assume projectRoot without verifying it exists
```

### incidents/index.md (Root Cause Records)
```
INC-2026-0512-001: Provider Documentation Drift
  Severity: Medium | Status: Resolved
  Root Cause: Docs listed K2.6 as primary; code uses minimax-free
  Impact: Model selection confusion, cost inefficiency
  Resolution: Updated MODEL_ALLOCATION.md from code source of truth
  Prevention: Before model chain changes, update reality first
```

---

## Part E: current-state.md Template

```markdown
# <SYSTEM>: Current Operator State
Last updated: YYYY-MM-DD | Updated by: <ROLE>

## Current Phase
Phase <N> — <GOAL>

## Verified Working (don't rebuild)
- [ ] Feature 1: verified in commit abc1234
- [ ] Feature 2: tested against live data on YYYY-MM-DD

## Partially Done (don't claim complete)
- Feature A: 70% done, blocker is X
- Feature B: stub only, real implementation pending Phase 3

## Top 3 Risks
1. Risk A — what: X, effect: Y, fix: Z
2. Risk B — ...
3. Risk C — ...

## Last Known Good State
Branch: <branch> | Commit: <hash> | Session: YYYY-MM-DD — <summary>
```

---

## Part F: Security Checklist

Before any agent runs in production:

```
[ ] DNA Contract enforced: No eval/exec/shell injections
[ ] Path traversal: resolve + bounds check + allowlist only
[ ] Input validation: LLM output sanitized before use or storage
[ ] Secret redaction: No API keys/tokens in logs/events/commits
[ ] Cost circuit breaker: Hard budget enforced, non-overridable
[ ] Approval gate: High-risk tasks require human sign-off (with timeout)
[ ] File integrity: Snapshot → write → verify triple gate
[ ] Rollback: Can revert any file to prior commit
[ ] Audit log: Every action → immutable event store
[ ] Least privilege: Agents cannot modify core system files
[ ] Timeout enforcement: Stuck agents killed and state recovered
```

---

## Part G: Observability

### Event schema (every agent action emits this)
```json
{
  "timestamp": "2026-05-15T14:23:00Z",
  "agent": "Coder",
  "taskId": "task-abc-123",
  "action": "file_write | llm_call | merge | restore",
  "status": "success | error | timeout",
  "metadata": {
    "file": "src/module.js",
    "cost_usd": 0.05,
    "latency_ms": 2340,
    "tokens_used": 1200,
    "confidence": 0.95,
    "error": null
  }
}
```

### Required health endpoints
```
GET /health              → { status: ok|degraded|down, uptime_ms }
GET /health/providers    → { provider: status } for each LLM/API
GET /health/cost         → { budget, spent, remaining, projected }
GET /metrics             → { task_success_rate, avg_latency, token_burn, confidence_dist }
```

### Dashboard metrics (minimum viable)
- Agent success rate per agent, with trend
- Cost tracking: cumulative, per-run, projected
- Latency percentiles: P50, P95, P99
- Task queue depth: pending / in-progress / blocked
- Solution memory hit rate: keyword vs semantic
- Provider health: availability, latency, error rate

---

## Part H: Fallback & Recovery

### Recovery supervisor pattern
```javascript
// Runs every 15 seconds
function recoveryLoop() {
  const stuck = findStuckTasks({ stuckThresholdMs: 240_000 });
  const overBudget = findOverBudgetTasks();
  const crashed = findCrashedAgents();

  stuck.forEach(task => {
    emit(incident('stuck_task', task.id));
    retryWithFeedback(task, { maxRetries: 3 });
    if (retriesExhausted) quarantine(task);
  });

  overBudget.forEach(task => {
    emit(incident('budget_exceeded', task.id, task.spentUsd));
    kill(task);
  });

  crashed.forEach(agent => {
    emit(incident('agent_crash', agent.name, agent.error));
    restart(agent);
  });
}
```

### Fallback chain logic
```
Call PRIMARY model
  → timeout (10s) or error
Call FALLBACK_1
  → timeout (15s) or error
Call FALLBACK_2
  → timeout (20s) or error
Call LOCAL model (always available)
  → all fail
Return { success: false, error: "All providers exhausted" }
Emit incident → notify operator
```

---

## Part I: Testing Requirements

```
Unit tests (required):
  - Agent input validation
  - JSON parsing edge cases (truncated, escaped, invalid)
  - Path traversal edge cases
  - Redaction logic (no secrets escape)
  - Cost calculation
  - Fallback chain invocation order

Integration tests (required):
  - Full pipeline with stubbed LLM
  - Real file I/O + recovery from interruption
  - Budget enforcement (hard stop at limit)
  - Multi-agent parallelism (no race conditions)

Security tests (required):
  - eval/exec/shell injection attempts → blocked
  - Secret patterns in output → redacted
  - Path traversal attempts → blocked
  - Unauthenticated API access → denied
```

---

## Part J: Minimum Documentation Structure

```
.claude/
├── CLAUDE.md              — system identity + core rules
├── ARCHITECTURE.md        — full system design
├── AGENTS.md              — per-agent reference
├── PATTERNS.md            — canonical code patterns
├── KNOWN_ISSUES.md        — recurring bugs + AI mistakes
├── ROADMAP.md             — phase gates + forward work
├── FORBIDDEN.md           — what NOT to do
└── rules/
    ├── memory-routing.md      — state management policy
    └── modification-policy.md — code change rules

memory/
├── current-state.md       — operator state (update manually)
├── scars.md               — hard-won lessons
├── incidents/
│   └── index.md           — root cause records
└── reality/
    ├── agents.yaml         — agent model chains (actual)
    ├── providers.yaml      — LLM provider status
    ├── pipeline.yaml       — agent behavior reality
    └── <subsystem>.yaml    — per-subsystem truth
```

---

## Part K: Customization Checklist

Before using this template for your system:

```
[ ] Replace <SYSTEM_NAME> with actual name
[ ] Replace <DOMAIN> with actual domain
[ ] Replace <LOCAL_STATE_STORE> (Blackboard / Redis / Zustand / other)
[ ] Replace <GUARDIAN_MODULE> (FileGuardian / equivalent path validator)
[ ] Set <AMOUNT> for hard budget (e.g. $2.00 per run)
[ ] Define agent names and replace <ROLE> throughout
[ ] Set <ROLE_TIMEOUT_SEC> per agent (300s long-ops, 60s quick)
[ ] Set <ROLE_TOKEN_LIMIT> per agent (16k reasoning, 8k quick)
[ ] Set <ROLE_OUTPUT_CAP_KB> (500KB typical)
[ ] Set recovery supervisor interval (15s recommended)
[ ] Customize fallback chain for your LLM providers
[ ] Create memory/reality/ files for your subsystems
[ ] Wire up observability endpoints for your framework
[ ] Define domain-specific security constraints
```

---

## How to use

1. Copy this file to `.claude/MULTI_AGENT_TEMPLATE.md` in your project
2. Work through Part K to customize placeholders
3. Create `memory/reality/` files for your subsystems (Part C)
4. Use Part B as the contract for every new agent you write
5. Start each agent system prompt by loading Parts A + B + relevant reality files

**Example agent system prompt:**
```
You are the Coder agent in <SYSTEM_NAME>.

[Part A: System Identity — loaded]
[Part B: Agent Design Contract — loaded]
[memory/current-state.md — loaded]
[memory/reality/pipeline.yaml — loaded]
[memory/reality/agents.yaml — loaded]
[.claude/KNOWN_ISSUES.md — loaded]

Task: <TASK>
```

---

*Part of [agentic-patterns](README.md) — production patterns for multi-agent AI systems.*
