# Pattern 04 — GraphDB for Agent Context

**Problem**: When an agent needs to understand a large codebase, it reads files sequentially or loads the entire AST. A 1000-file project burns 8–12KB tokens just to show the directory structure. An architect working on a refactor needs to know "what calls this function?" or "what does this module export?" — but extracting that from raw file content is slow and expensive.

**Solution**: Build a lightweight dependency graph (file tree + function definitions + call edges) once, then let agents navigate via queries. A navigation question ("show me all functions this agent touched") costs <50 tokens instead of 2000.

---

## Why Not AST? Why Graphs Work

**AST (Abstract Syntax Trees)**:
- Pro: Hyper-precise (every operator, every binding)
- Con: Huge (JS AST for 100 lines of code ≈ 50KB JSON)
- Con: Overkill (agents don't need operator-level detail)

**Lightweight graph**:
- Pro: ~1% of AST size
- Pro: Human-readable query results
- Pro: Queryable (SQL-like "show X")
- Con: Loss of implementation detail (but agents don't need it for navigation)

**When to use**: Agents doing refactors, impact analysis, dependency cleanup.  
**When to skip**: Parse errors, binary files, generated code.

---

## Graph Schema

Three node types:

```javascript
// Node: represents a code entity
{
  id: "file:src/agents/BaseAgent.js",
  type: "file",
  name: "BaseAgent.js",
  path: "src/agents/BaseAgent.js",
  language: "javascript",
  size_bytes: 2840,
  lines: 95,
  exports: ["BaseAgent", "cleanJSON"]  // what this file exports
}

{
  id: "func:src/agents/BaseAgent.js:callLLM",
  type: "function",
  name: "callLLM",
  file: "src/agents/BaseAgent.js",
  line_start: 34,
  line_end: 67,
  params: ["goal", "context", "blackboard"],
  returns: "Promise<LLMResponse>"
}

{
  id: "module:src/core/Blackboard",
  type: "module",
  name: "Blackboard",
  path: "src/core/Blackboard.js",
  exports: ["Blackboard", "BudgetExceededError"]
}
```

Two edge types:

```javascript
// Edge: represents a relationship
{
  from: "func:src/agents/BaseAgent.js:callLLM",
  to: "func:src/core/Blackboard.js:appendNote",
  type: "calls",  // func A calls func B
  line: 52
}

{
  from: "file:src/agents/ResearcherAgent.js",
  to: "file:src/agents/BaseAgent.js",
  type: "imports",  // imports/requires
  line: 1
}

{
  from: "func:src/agents/BaseAgent.js:_callProvider",
  to: "func:src/core/BaseAgent.js:cleanJSON",
  type: "calls_external"
}
```

---

## Building the Graph

Parse each file once (on startup), extract:
- File-level imports/exports
- Function definitions (name, params, return type hint)
- Function calls (via regex or lightweight AST parse)

```javascript
// Pseudocode: Graph builder

class CodeGraph {
  constructor() {
    this.nodes = new Map();  // id -> Node
    this.edges = [];          // [{ from, to, type, line }, ...]
  }

  async buildFromDirectory(rootPath) {
    const files = await walk(rootPath, { include: ['*.js', '*.ts', '*.py'] });

    for (const file of files) {
      const content = await fs.readFile(file, 'utf-8');
      const relPath = path.relative(rootPath, file);

      // 1. Create file node
      const fileNode = {
        id: `file:${relPath}`,
        type: 'file',
        name: path.basename(file),
        path: relPath,
        language: this.detectLanguage(file),
        size_bytes: content.length,
        lines: content.split('\n').length,
        exports: this.extractExports(content)
      };
      this.nodes.set(fileNode.id, fileNode);

      // 2. Extract functions & create function nodes
      const functions = this.extractFunctions(content, relPath);
      for (const fn of functions) {
        this.nodes.set(fn.id, fn);
      }

      // 3. Extract imports -> create edges
      const imports = this.extractImports(content);
      for (const imp of imports) {
        this.edges.push({
          from: `file:${relPath}`,
          to: `file:${imp.path}`,
          type: 'imports',
          line: imp.line
        });
      }

      // 4. Extract function calls -> create edges
      const calls = this.extractCalls(content, relPath);
      for (const call of calls) {
        this.edges.push({
          from: `func:${call.caller}`,
          to: `func:${call.callee}`,
          type: 'calls',
          line: call.line
        });
      }
    }

    console.log(`Graph built: ${this.nodes.size} nodes, ${this.edges.length} edges`);
  }

  // Query: "Show me all functions that call X"
  callersOf(funcId) {
    return this.edges
      .filter(e => e.to === funcId && e.type === 'calls')
      .map(e => this.nodes.get(e.from));
  }

  // Query: "Show me all functions that X calls"
  callsOf(funcId) {
    return this.edges
      .filter(e => e.from === funcId && e.type === 'calls')
      .map(e => this.nodes.get(e.to));
  }

  // Query: "Show me all files in src/agents/"
  filesIn(dir) {
    return Array.from(this.nodes.values())
      .filter(n => n.type === 'file' && n.path.startsWith(dir));
  }

  // Query: "What does this file depend on?"
  dependenciesOf(fileId) {
    return this.edges
      .filter(e => e.from === fileId && e.type === 'imports')
      .map(e => this.nodes.get(e.to));
  }

  // Export as prompt-friendly text
  contextFor(nodeIds, depth=2) {
    // Multi-hop traversal: show node + neighbors + neighbors' neighbors
    let context = '';
    for (const id of nodeIds) {
      const node = this.nodes.get(id);
      context += `## ${node.name} (${node.type})\n`;
      context += `Location: ${node.path}:${node.line_start || ''}\n`;

      if (depth > 0) {
        const neighbors = this.callsOf(id) || this.dependenciesOf(id);
        context += `Depends on: ${neighbors.map(n => n.name).join(', ')}\n\n`;
      }
    }
    return context;
  }
}
```

---

## Integration with Agents

Pass the graph to Architect/Coder at initialization:

```javascript
const graph = new CodeGraph();
await graph.buildFromDirectory('./src');

const architect = new ArchitectAgent(graph);

class ArchitectAgent extends BaseAgent {
  constructor(codeGraph) {
    super('Architect');
    this.graph = codeGraph;
  }

  buildPrompt(goal, context, blackboard) {
    // Example: agent needs to refactor BaseAgent.callLLM()
    const targetFunc = 'func:src/agents/BaseAgent.js:callLLM';

    // Query graph for impact
    const callers = this.graph.callersOf(targetFunc);
    const callees = this.graph.callsOf(targetFunc);

    const graphContext = `
Target function: BaseAgent.callLLM()
Callers (functions that use it): ${callers.map(n => n.name).join(', ')}
Callees (functions it uses): ${callees.map(n => n.name).join(', ')}

Impact: If you change callLLM's signature, ${callers.length} functions need updates.
`;

    return `${goal}\n\nCode structure:\n${graphContext}`;
  }
}
```

---

## Real Example: SDLC Route Change

**Scenario**: Architect needs to add a new route endpoint to SDLC's HTTP server.

**Without graph**:
- Read `index.js` (2KB tokens)
- Read `src/routes/` directory listing (0.5KB tokens)
- Read each route file to understand pattern (3KB tokens per file × 4 files = 12KB tokens)
- Total: ~15KB tokens, 8 minutes elapsed

**With graph**:
- Query: "Show me all route files"
  ```
  src/routes/goal.js (exports goalHandler, 120 lines)
  src/routes/audit.js (exports auditHandler, 95 lines)
  src/routes/recover.js (exports recoverHandler, 87 lines)
  src/routes/status.js (exports statusHandler, 72 lines)
  ```
  (200 tokens)

- Query: "What does goalHandler import?"
  ```
  imports: Blackboard, DAGRunner, PlannerAgent, ResearcherAgent, Architect, Coder, Auditor, Documenter
  ```
  (100 tokens)

- Architect builds new route by pattern-matching against existing ones
  (300 tokens for code generation)

- **Total: 600 tokens, 90 seconds**

---

## Observability & Maintenance

Store graph metadata in reality files:

```yaml
memory/reality/codebase-graph.yaml:
  working:
    - claim: "Dependency graph covers all src/ files"
      verify: "ls -la src/ && wc -l graph.json"
    - claim: "Callers/callees queryable for refactor impact analysis"
      verify: "grep -c '\"type\": \"calls\"' graph.json"
  stubs:
    - "Auto-sync graph on file changes (requires file watcher)"
    - "Detect circular dependencies"
    - "Show dead code (nodes with no callers)"
```

---

## Trade-Offs

| Benefit | Cost |
|---------|------|
| 95% token reduction for navigation | Graph build time (30s for 1000 files) |
| "Show me the impact" questions | Graph staleness (must rebuild on changes) |
| Precise refactor planning | Parse errors crash graph builder |
| Human-readable query results | Complexity in setup (one-time) |

**When to use**: Projects >50 files, refactors that touch multiple modules, impact analysis.  
**When to skip**: Tiny projects, scripts, frequent file changes without rebuild.

---

## Security Invariants (Path Traversal & MCP Sandboxing)

When utilizing a codebase dependency graph inside Model Context Protocol (MCP) servers or autonomous agent prompts, validate files to prevent traversal exploits:

1. **Normalized Path Validation**: Before resolving nodes or dependencies, normalize all relative path inputs (e.g. using `path.resolve` or `os.path.abspath`) to remove directory traversal characters (`../`).
2. **Workspace Allowlisting**: Compare the normalized absolute path of every queried file or dependency edge against the allowlisted workspace root sandbox. If the target resides outside this directory, block the request to mitigate sandbox escapes (e.g. CVE-2025-53110 / CVE-2025-53109).
3. **Symlink Validation**: Resolve symbolic links before validation checks to prevent files from mapping pathways to sensitive system folders (e.g., SSH directories).

---

## Building on the Foundation

From here, you can:
1. **Add IDE integration**: VS Code extension that shows "who calls this?" inline
2. **Add circular dependency detection**: Flag before they break
3. **Add dead code detection**: Find unused functions, mark for deprecation
4. **Add cost annotation**: "This function calls LLM 3x; refactor saves $2/run"

---

## Summary

A lightweight graph of dependencies lets agents:
- Answer "what calls this?" in one query (vs. scanning 12 files)
- Estimate refactor impact before coding
- Navigate large codebases without loading everything into context

This scales from 50-file projects to 5000+ file monorepos.
