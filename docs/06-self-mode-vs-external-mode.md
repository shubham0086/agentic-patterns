# Pattern 06 — Self-Mode vs External-Mode

**Problem**: An agent system can improve itself (self-mode) or operate on other projects (external-mode). Mixing them is dangerous. In self-mode, an agent writing files to the wrong directory corrupts its own codebase. In external-mode, an agent without proper guardrails can delete a user's project. This pattern enforces a clear boundary: what mode are you in, and what are you allowed to do?

**Real incident**: SCAR-004 (2026-05-22). Jarvis HUD agent invoked on SDLC project. Agent wrote 49 files to the wrong repository root, destroying 2 hours of work. Root cause: no mode check; agent assumed it was operating on Jarvis but was actually in SDLC.

---

## The Two Modes

### Mode 1: SELF
- Agent improves its own codebase (the system it's running in)
- Example: "Add a health check endpoint to SDLC's HTTP server"
- **Working directory**: Your repo (c:\path\to\agentic-sdlc)
- **Guardrails**: Trust your own reality files; no external project verification needed
- **Safety**: Medium (you can always revert your own changes)

### Mode 2: EXTERNAL
- Agent operates on a *different* project (passed as `projectRoot` argument)
- Example: "Add a health check endpoint to a user's Rails app"
- **Working directory**: User's project (c:\path\to\user-app)
- **Guardrails**: STRICT — verify project exists, verify it's the intended target, isolate in git branch, dry-run before merge
- **Safety**: High (git branch isolation means no data loss even on total failure)

---

## Mode Detection & Safety Contract

```javascript
// BaseAgent.js — Add this to every agent

class BaseAgent {
  constructor(name, mode = null) {
    this.name = name;
    this.mode = mode || 'self';  // default to self
  }

  async execute(goal, context, blackboard, projectRoot = null) {
    // 1. Determine mode
    if (projectRoot && projectRoot !== process.cwd()) {
      this.mode = 'external';
    } else {
      this.mode = 'self';
    }

    // 2. Safety check based on mode
    if (this.mode === 'external') {
      await this.verifySafetyContract(projectRoot, blackboard);
    }

    // 3. Isolate in git branch (external only)
    if (this.mode === 'external') {
      await this.isolateInBranch(projectRoot);
    }

    // 4. Execute
    return await this._execute(goal, context, blackboard);
  }

  async verifySafetyContract(projectRoot, blackboard) {
    // Safety checks before touching external project

    // A. Verify project exists
    if (!fs.existsSync(projectRoot)) {
      throw new Error(`SAFETY VIOLATION: projectRoot "${projectRoot}" does not exist`);
    }

    // B. Verify it's a git repo (so we can isolate changes)
    if (!fs.existsSync(path.join(projectRoot, '.git'))) {
      throw new Error(`SAFETY VIOLATION: "${projectRoot}" is not a git repository`);
    }

    // C. Verify intended target
    const projectName = path.basename(projectRoot);
    const goal = blackboard.goal;

    // Simple heuristic: does goal mention the project name?
    if (!goal.toLowerCase().includes(projectName.toLowerCase())) {
      // Warn, don't block (could be intentional)
      console.warn(`[SAFETY] Goal doesn't mention project name "${projectName}"`);
      blackboard.appendNote('Safety', `Goal mismatch warning for project "${projectName}"`);
    }

    // D. Snapshot current state (for rollback if needed)
    const snapshot = {
      projectRoot,
      gitHead: await this.getGitHead(projectRoot),
      timestamp: new Date(),
      goal
    };
    blackboard.addTask('safety_snapshot', snapshot);
  }

  async isolateInBranch(projectRoot) {
    // In external mode: create isolated git branch, revert to main on failure

    const timestamp = Date.now();
    const branchName = `agent-task-${timestamp}`;

    // Create branch
    await exec(`git checkout -b ${branchName}`, { cwd: projectRoot });
    console.log(`[ISOLATION] Working on branch: ${branchName}`);

    blackboard.appendNote('Safety', `Created isolation branch: ${branchName}`);

    // On completion, merge back to main or revert
    // See: merge logic below
  }

  async mergeOrRevert(projectRoot, success = true) {
    // Called after agent finishes

    if (!success) {
      // Revert: delete branch, go back to main
      await exec(`git checkout main`, { cwd: projectRoot });
      await exec(`git branch -D ${currentBranch}`, { cwd: projectRoot });
      console.log(`[ISOLATION] Reverted due to failure. Changes discarded.`);
      return;
    }

    // Success: merge branch to main
    await exec(`git checkout main`, { cwd: projectRoot });
    await exec(`git merge ${currentBranch} --no-ff`, { cwd: projectRoot });
    console.log(`[ISOLATION] Merged ${currentBranch} to main.`);
  }

  getGitHead(projectRoot) {
    // Return current commit hash for rollback
    const result = execSync('git rev-parse HEAD', { cwd: projectRoot });
    return result.toString().trim();
  }
}
```

---

## SCAR-004 Incident: What Went Wrong

**Timeline**:

```
2026-05-22 10:00 — User: "Add a health check endpoint to Jarvis HUD"
                    (intended projectRoot: jarvis-system/)

2026-05-22 10:05 — Architect starts in SDLC project context
                    (actual projectRoot: agentic-sdlc/)

2026-05-22 10:06 — Architect reads "health check" + "endpoint"
                    Assumes: "This is an HTTP server. All HTTP servers are similar."
                    (ERROR: Jarvis is React, SDLC is Node.js/Express)

2026-05-22 10:07 — Architect generates 49 files
                    Writes to: agentic-sdlc/src/routes/health.js
                    Writes to: agentic-sdlc/.claude/HEALTH.md
                    ... (47 more files in wrong repo)

2026-05-22 10:30 — User sees 49 uncommitted files in SDLC (not Jarvis)
                    SCAR-004 logged
```

**Root cause**: No mode check. Agent had no idea it was in "external mode" or that the projectRoot was wrong.

**Prevention**:

Before any agent writes files, it must answer:
1. **What mode am I in?** (self or external)
2. **If external, do I have projectRoot?** (fail if not)
3. **If external, does projectRoot exist?** (fail if not)
4. **If external, am I in a git branch?** (fail if not)

---

## Safe External Mode: The Full Flow

### Step 1: Verify Target (Pre-Execution)

```javascript
async function executeExternalTask(goal, projectRoot, agentName) {
  const agent = new AgentClass(agentName);

  // Pre-flight checks
  if (!fs.existsSync(projectRoot)) {
    throw new Error(`Project not found: ${projectRoot}`);
  }

  if (!fs.existsSync(path.join(projectRoot, '.git'))) {
    throw new Error(`Not a git repo: ${projectRoot}`);
  }

  // Confirm with user (in interactive mode)
  console.log(`About to run ${agentName} on: ${projectRoot}`);
  console.log(`Goal: ${goal}`);
  // User confirms: Y/N

  return agent.execute(goal, null, blackboard, projectRoot);
}
```

### Step 2: Isolate in Branch (Execution)

Agent creates isolated branch before writing:
```bash
git checkout -b agent-task-1716403200
# All writes happen here
# If agent fails: git checkout main && git branch -D agent-task-...
# If agent succeeds: git merge agent-task-1716403200
```

### Step 3: Verify Changes (Post-Execution)

```javascript
async function verifyChanges(projectRoot) {
  // What files changed?
  const diff = execSync('git diff main..HEAD --name-only', { cwd: projectRoot });
  console.log('Files changed:\n' + diff);

  // User reviews: "Does this look right?"
  // If no: agent discards branch
  // If yes: agent merges to main
}
```

---

## Checklist: Before External Operation

```yaml
safety_checklist_external_mode:
  - [ ] Goal clearly names the target project
  - [ ] projectRoot argument is provided and exists
  - [ ] projectRoot is a git repository
  - [ ] User has confirmed the goal and target
  - [ ] Agent created isolated branch (not writing to main)
  - [ ] Agent verified no secrets in .env files
  - [ ] Agent ran tests (if available) on isolation branch
  - [ ] User reviewed git diff before merge
  - [ ] merge/revert logic is sound (success → merge, failure → revert)
```

---

## Implementation: Mode-Aware DAGRunner

Modify the DAGRunner to track and enforce mode:

```javascript
class DAGRunner {
  constructor(mode = 'self', projectRoot = null) {
    this.mode = mode;
    this.projectRoot = projectRoot;
  }

  async run(blackboard) {
    // Set mode on all nodes before execution
    for (const [nodeName, node] of this.graph.entries()) {
      node.agent.mode = this.mode;
      node.agent.projectRoot = this.projectRoot;

      if (this.mode === 'external') {
        await node.agent.verifySafetyContract(this.projectRoot, blackboard);
      }
    }

    // ... rest of topological sort and execution
  }
}
```

---

## Real Example: SDLC Self-Mode vs Jarvis External-Mode

**Scenario 1: SDLC Self-Mode**
```bash
node index.js --goal "Add a health check endpoint"
# mode: 'self'
# projectRoot: <cwd> (agentic-sdlc/)
# guardrails: Trust memory/reality/, reality files are authoritative
# isolation: None (you own this repo, revert via git if needed)
```

**Scenario 2: Jarvis External-Mode**
```bash
node index.js --goal "Add a health check endpoint" --project C:\path\to\jarvis-system
# mode: 'external'
# projectRoot: C:\path\to\jarvis-system
# guardrails: Verify .git exists, verify goal mentions "jarvis", create isolation branch
# isolation: Strict (all changes in agent-task-NNN branch, user merges after review)
```

---

## Trade-Offs

| Benefit | Cost |
|---------|------|
| Clear mode boundary prevents cross-project corruption | Requires user confirmation (not fully autonomous) |
| Git branch isolation = no data loss even on crash | Branch cleanup on large projects (slow) |
| Snapshot + rollback safety | Complexity in DAGRunner |
| Safety checklists prevent SCAR incidents | Overhead per external task |

---

## When to Use

**Self-mode** (default):
- Agent improves its own codebase
- Rapid iteration (no branch overhead)
- Safe because you control the repo

**External-mode** (opt-in):
- Operating on user's project
- Integrating with third-party tools
- When data loss is unacceptable (financial, critical)

---

## Summary

Self-mode vs external-mode is the difference between:
- **Self**: "I'm improving myself" (trust, no isolation needed)
- **External**: "I'm improving someone else's project" (verify target, isolate in branch)

Enforce mode at the DAGRunner level, verify at the agent level, and always give users the power to review and revert.

SCAR-004 happened because there was no mode check. This pattern prevents it from happening again.
