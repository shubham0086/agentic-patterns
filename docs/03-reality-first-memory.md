# Pattern 03 — Reality-First Memory

**Problem**: Agents accumulate observations in a Blackboard, but the Blackboard is ephemeral—flushed at runtime end. If a 3-hour pipeline completes a complex task, no agent in a *future* pipeline sees what happened. You lose continuity. Agents re-solve the same problems. You burn tokens and time.

**Solution**: Persist solution memory to SQLite (long-term) + route short-term queries to Blackboard (ephemeral) + trust *actual* queries over documented claims.

---

## The Problem: Amnesia at Boundaries

Consider a multi-day autonomous project:

- **Day 1**: Researcher investigates "what's the best way to handle distributed transactions in Node.js?" Documents findings in Blackboard notes.
- **Day 2**: Same researcher gets a new goal. The Blackboard is fresh. Researcher re-reads the same articles, re-produces the same summary, wastes 40 API calls and $2.

Or worse:

- **Day 1**: Architect maps the current codebase, stores the graph in Blackboard.
- **Day 2**: Auditor needs to understand the same codebase. Architect is offline. Auditor can't access yesterday's graph. Auditor rebuilds it from scratch.

**Root cause**: Blackboard is append-only *within a run*, but disappears *between runs*. You have no long-term memory of what was learned, decided, or verified.

---

## The Solution: SQLite Solution Memory

Store three classes of persistent state:

### 1. Solution Table
```sql
CREATE TABLE solutions (
  id INTEGER PRIMARY KEY,
  task_id TEXT,                -- parent goal/ticket
  agent_name TEXT,             -- who produced it
  summary TEXT,                -- what was learned
  source_url TEXT,             -- where the answer came from (optional)
  timestamp DATETIME,
  cost_usd REAL,               -- what it cost
  tokens_used INTEGER,
  confidence_pct INTEGER,      -- 0-100
  verified BOOLEAN             -- did downstream agent confirm?
);
```

### 2. Incident Table
```sql
CREATE TABLE incidents (
  id INTEGER PRIMARY KEY,
  scar_id TEXT,                -- SCAR-NNN reference
  root_cause TEXT,
  prevention TEXT,
  date_logged DATETIME,
  status TEXT                  -- open/resolved
);
```

### 3. State Snapshots Table
```sql
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY,
  run_id TEXT,                 -- unique per execution
  checkpoint TEXT,             -- "post-plan", "pre-architect", etc
  blackboard_state JSONB,      -- entire blackboard serialized
  timestamp DATETIME
);
```

---

## Memory Routing Policy

**In-pipeline (short-term)**: Use Blackboard.  
**Session continuity (operational)**: Use task queue (Blackboard.addTask).  
**Cross-session (long-term)**: Use SQLite solutions table.

```javascript
// Pseudocode: Agent requests prior knowledge

class BaseAgent {
  async callLLM(goal, blackboard, db) {
    // 1. Check SQLite for prior solutions
    const priorSolutions = await db.query(
      "SELECT summary FROM solutions WHERE task_id LIKE ? AND verified = 1",
      [goal.substring(0, 20) + '%']
    );

    // 2. If found and recent (<7 days), add to context
    let context = "";
    if (priorSolutions.length > 0 && isPrior(7)) {
      context = "Relevant prior learning:\n" + priorSolutions[0].summary;
    }

    // 3. Execute LLM call with enriched context
    const response = await this._callProvider(goal, context);

    // 4. After execution, log to SQLite
    await db.insert('solutions', {
      task_id: goal.substring(0, 20),
      agent_name: this.name,
      summary: response.output,
      timestamp: new Date(),
      cost_usd: response.cost,
      tokens_used: response.tokens,
      verified: false  // downstream agent verifies
    });

    return response;
  }
}
```

---

## Real Example: Multi-Day Project

**Session 1** (Monday, 9am):
- Researcher investigates "multi-tenant SaaS billing architecture"
- Cost: $2.50, 1200 tokens
- Blackboard note: "Solution: Stripe + per-customer ledger + monthly reconciliation"
- SQLite entry: solutions(task_id='multi-tenant', summary='...', cost=2.50, verified=false)

**Session 2** (Tuesday, 2pm):
- New goal: "Design a refund system for multi-tenant SaaS"
- Architect queries SQLite: "SELECT summary FROM solutions WHERE task_id LIKE 'multi-tenant%' AND verified = 1"
- Finds Monday's solution
- Reuses: "We already handle multi-tenant with Stripe + ledger. Refunds map to ledger debits."
- Cost: $0 (no LLM call needed)
- Time: 30 seconds instead of 20 minutes

**Session 3** (Wednesday, 10am):
- Auditor finds a bug: "The refund logic doesn't handle partial refunds."
- Updates solutions table: `UPDATE solutions SET verified = 0 WHERE task_id = 'multi-tenant'`
- Logs incident: `INSERT INTO incidents (scar_id='SCAR-005', root_cause='...')`
- Future agents see the incident and re-verify before relying on the solution.

---

## Pre-Query Checklist (Anti-Hallucination)

Before an agent relies on any prior solution from memory:

1. **Verify recency**: Is the solution <7 days old? (Or adjust threshold.)
2. **Verify confidence**: Does solutions.confidence_pct > 70?
3. **Verify no incidents**: Run `SELECT * FROM incidents WHERE root_cause LIKE solution.task_id` — if found, re-verify.
4. **Verify downstream**: If solutions.verified = false, treat as unconfirmed; include in context but flag as "not yet validated."
5. **Verify scope match**: Does the prior solution apply to this *exact* goal, or just similar?

```python
# Pseudocode: Agent request with verification

async def request_prior_solution(goal, db):
    candidates = await db.query("""
        SELECT * FROM solutions 
        WHERE task_id LIKE ? 
        AND verified = 1
        AND confidence_pct > 70
        AND DATE(timestamp) > DATE('now', '-7 days')
    """, [goal[:20] + '%'])
    
    # Check for blocking incidents
    blocking_incidents = []
    for sol in candidates:
        incidents = await db.query(
            "SELECT * FROM incidents WHERE root_cause LIKE ?",
            [sol.task_id + '%']
        )
        if incidents:
            blocking_incidents.extend(incidents)
    
    # If blocking incidents, raise alert
    if blocking_incidents:
        return None, blocking_incidents  # Agent must re-solve
    
    return candidates[0] if candidates else None, []
```

---

## Trade-Offs

| Benefit | Cost |
|---------|------|
| Eliminate duplicate work across sessions | Database maintenance (schema, migrations) |
| Token savings on repeated queries | Stale solution detection (manual review) |
| Continuity across agent swaps | Privacy/data retention policy (what to delete?) |
| Measurable cost reduction over time | Confidence scoring requires human feedback |

**When to use SQLite memory**: Multi-day projects, recurring research queries, high-cost LLM calls.  
**When to skip**: Throwaway one-shot tasks, rapidly changing goals, high-risk domains (security, medical).

---

## Observability Hook

Log every SQLite write:

```yaml
memory/reality/persistence.yaml:
  working:
    - claim: "Solutions persisted to SQLite with recency + confidence filtering"
      verify: "SELECT COUNT(*) FROM solutions WHERE verified = 1 AND DATE(timestamp) > DATE('now', '-7 days')"
    - claim: "Incidents logged and discoverable before solution reuse"
      verify: "SELECT scar_id, root_cause FROM incidents ORDER BY date_logged DESC LIMIT 5"
  stubs:
    - "Automated confidence scoring (requires post-run feedback)"
    - "Cross-project solution transfers (privacy-aware)"
```

---

## Next: Integration with Blackboard

The Blackboard should expose an interface to SQLite:

```javascript
// In BaseAgent
class BaseAgent {
  async enrichContextWithPriorLearning(goal, blackboard) {
    if (!blackboard.db) return "";  // SQLite optional
    const solutions = await blackboard.db.solutions.findRecent(goal, maxAge=7);
    return solutions.map(s => `[Prior: ${s.agent_name}] ${s.summary}`).join("\n");
  }
}
```

Pass the db connection into Blackboard at startup:
```javascript
const db = new Database('solutions.sqlite');
const blackboard = new Blackboard(goal, { db });
```

---

## Summary

Reality-first memory means:
1. **SQLite persists** what was learned.
2. **Memory routing** determines where to search (Blackboard vs SQL vs reality files).
3. **Verification checklist** prevents stale solutions from propagating.
4. **Observability** shows what's trusted, what's blocked, and why.

This pattern scales from 2-agent pipelines to 100+ agent days of continuous work.
