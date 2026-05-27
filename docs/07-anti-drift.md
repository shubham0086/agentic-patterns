# Pattern 07 — Anti-Drift: Preventing Agents from Hallucinating Their Own Architecture

## The problem

Your agent system works correctly on day 1. By week 3, it generates code that imports modules from the wrong path, calls APIs that were refactored away, and makes architectural decisions that contradict decisions already made last session.

The agents are not getting dumber. They are working from stale information.

This is **architectural drift** — the gap between what the system's documentation says it does, what the agents believe the system does, and what the code actually does. In long-running agentic systems, this gap grows quietly and expresses as degraded output quality, hallucinated file paths, and agents confidently contradicting themselves across sessions.

---

## Why it happens

### Documentation lags code

Agents read architecture docs, READMEs, and comments to understand the codebase they are operating on. But documentation is written once and updated infrequently. After three sessions of code generation, the architecture docs describe a system that no longer exists.

Example: your architecture doc says "agents read state from `blackboard.state.tasks`" — but two sessions ago, the Coder refactored this to `blackboard.getActiveTasks()`. Every agent that reads the architecture doc and trusts it will generate code with the old API. The system still runs because the old property is still there (backward-compat shim) — until it isn't, at which point errors appear with no obvious cause.

### Agent memory is context-scoped, not code-scoped

An agent's understanding of the codebase comes from:
1. What it was told (prompts, docs)
2. What it can see (files it reads in context)
3. What it remembers (previous session notes in memory)

None of these are automatically updated when the code changes. The code is the ground truth. Everything else is a claim about what the code does. When those claims diverge from the code, agents drift.

### Hallucination amplifies with each session

In session 1, the agent makes a small wrong assumption about a file path. The code it generates almost works. In session 2, the next agent builds on that assumption. By session 5, the wrong assumption is baked into three files and a memory note. Correcting it requires understanding why the drift happened, not just what is wrong now.

---

## The pattern

Two components: **reality files** (ground truth snapshots) and a **pre-edit verification checklist** (enforced before any code change).

### 1. Reality files

A `memory/reality/` directory containing YAML files that describe the *current verified state* of critical subsystems. Not aspirational documentation — verified facts.

```yaml
# memory/reality/pipeline.yaml
# Last verified: 2026-05-22 by Auditor agent
# Verify by: grep -r "blackboard\." src/agents/ | head -20

pipeline:
  entry_point: index.js
  state_api:
    read_tasks: blackboard.getActiveTasks()      # NOT blackboard.state.tasks (refactored 2026-05-10)
    add_task: blackboard.addTask(goal, metadata)
    update_task: blackboard.updateTask(id, patch)
  agents:
    - name: Researcher
      file: src/agents/Researcher.js
      input: blackboard.state.goal
      output: appends to blackboard.state.researchNotes
    - name: Architect
      file: src/agents/Architect.js
      input: blackboard.state.researchNotes
      output: writes to blackboard.state.architecturePlan
  current_model_primary: minimax-m2.5-free
  current_model_fallback: qwen.qwen3-coder-30b-a3b-instruct (bedrock)
```

```yaml
# memory/reality/agents.yaml
# Last verified: 2026-05-22

agents:
  base_class: src/core/BaseAgent.js
  required_methods:
    - execute(blackboard): Promise<void>
    - cleanJSON(raw): object    # use this, never JSON.parse() on LLM output
  forbidden:
    - eval()
    - import (use require())
    - JSON.parse() on raw LLM output
    - direct blackboard.state mutation
  timeout_config: src/core/BaseAgent.js line 148
```

Reality files are different from architecture docs in one critical way: they are short, specific, and verified by running the actual code. Any claim in a reality file must have a verification command that proves it.

### 2. The pre-edit checklist

Before any agent writes code or makes a significant architectural decision, it verifies the relevant reality files — and if they conflict with what the code actually does, it updates the reality file before proceeding.

The checklist order matters:

```
Before editing code:
1. Read memory/current-state.md          — what is running right now?
2. Read memory/reality/<subsystem>.yaml  — what is true about this subsystem?
3. Run the verify command in the YAML    — does the code match the claim?
4. If conflict → update the reality file first, then proceed
5. Read src/core/BaseAgent.js            — what are the actual current models and APIs?
6. Check .claude/KNOWN_ISSUES.md        — has someone already hit this?
```

The third step is the one that gets skipped and causes the most drift. Agents are reluctant to run verification commands because they slow down the task. This is exactly backwards — the verification command takes 5 seconds; diagnosing drift after 3 sessions of compounding errors takes hours.

### 3. SCAR (Significant Cause and Resolution) system

When a drift incident causes a meaningful failure — wrong API calls, wrong file paths, hallucinated module names — record it:

```markdown
<!-- .claude/sessions/2026-05-22-wrong-repo-scar.md -->

## SCAR-004: Wrong Repository Incident

**What happened**: Architect generated 49 `.jsx` files into Agentic-SDLC repo
instead of the jarvis-system target repo.

**Root cause**: External-mode rule not enforced. Researcher did not verify
`apps/hud/` existed in projectRoot before planning. Architect used `.jsx`
instead of `.tsx` despite jarvis-system being TypeScript-only.

**Verified fix**: Added SCAR RULE to CLAUDE.md:
  "Any goal mentioning Jarvis, HUD, companion, or jarvis-system MUST use
  projectRoot: C:\...\jarvis-system and mode: external"

**Prevention**: Researcher MUST verify `apps/hud/` exists at projectRoot.
Architect MUST plan `.tsx` files for jarvis-system tasks.

**Cost**: 2 days of wasted work.
```

SCAR files serve two purposes: they prevent the same failure from happening twice (the rule is now in CLAUDE.md), and they build a searchable history of what the system has gotten wrong. Before starting any task in an area where a SCAR exists, the agent reads the SCAR first.

---

## The "trust code, not docs" rule

When a reality file, an architecture document, and the actual code all say different things, the priority is:

```
Code (git blame)  >  reality files (recent + verified)  >  architecture docs  >  agent memory
```

This seems obvious until you are in the middle of a long session and an agent confidently tells you the API works a certain way because it says so in the architecture doc — and you trust it because writing the verification command feels like extra work.

Run the verification command. The doc is wrong more often than you expect.

### Practical implementation

Build a simple verification routine that agents run before editing any file in a subsystem:

```javascript
// Called by any agent before touching src/agents/ or src/core/
async function verifySubsystemReality(subsystem) {
  const realityPath = `memory/reality/${subsystem}.yaml`;
  const reality = yaml.load(fs.readFileSync(realityPath));

  for (const claim of reality.verify_commands || []) {
    const result = execSync(claim.command).toString().trim();
    if (!result.includes(claim.expected)) {
      console.warn(`Reality mismatch in ${subsystem}: ${claim.description}`);
      console.warn(`Expected: ${claim.expected}`);
      console.warn(`Got: ${result}`);
      // Return the mismatch — agent must update reality file before proceeding
      return { valid: false, mismatch: claim.description };
    }
  }
  return { valid: true };
}
```

```yaml
# memory/reality/pipeline.yaml — with verify commands
verify_commands:
  - description: "blackboard state API"
    command: "grep -r 'blackboard\\.getActiveTasks' src/core/Blackboard.js"
    expected: "getActiveTasks"
  - description: "BaseAgent extends check"
    command: "grep 'extends BaseAgent' src/agents/Researcher.js"
    expected: "extends BaseAgent"
```

---

## Trade-offs

**Cost of this pattern**: Writing and maintaining reality files takes time. Verification commands must be kept up to date. If verification is treated as optional, the whole system degrades into documentation theater — files that claim to show truth but aren't verified.

**When anti-drift is critical**:
- Multi-session pipelines (any system running across more than one conversation window)
- Systems that modify their own code (self-improvement loops)
- External-mode systems that operate on a separate target codebase

**When it's overkill**:
- Short-lived pipelines (one session, one task, then done)
- Read-only agents that don't generate code
- Prototypes where drift is acceptable

**The minimum viable version**: If you don't want the full reality-file system, at minimum adopt the rule: **"Check git log before trusting any documentation."** A 3-second `git log --oneline -20` tells you more about what changed recently than reading any docs file. Code changed → docs are suspect.

---

## Where this came from

Every anti-drift mechanism in this doc was added to **Agentic-SDLC** in response to a specific failure:

- Reality files: after SCAR-003, where agents disagreed on which Blackboard API was current
- Pre-edit checklist: after two sessions of compounding wrong-path errors
- SCAR system: after SCAR-004 (the 49-wrong-file incident), which cost 2 days of work
- "Trust code, not docs" rule: after noticing agents confidently citing outdated architecture docs while the code contradicted them

The system now surfaces these rules in the project's `CLAUDE.md` and `.claude/KNOWN_ISSUES.md` so they are loaded at the start of every session, not discovered after the fact.

---

*Previous: [Pattern 06 — Self-Mode vs External-Mode](06-self-vs-external-mode.md)*
*Back to: [README](../README.md)*
