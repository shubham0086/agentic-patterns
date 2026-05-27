# Setup Guide

Get a working 2-agent pipeline running in under 10 minutes.
Both starters run with **zero API keys** using Ollama (local models).

---

## Prerequisites

- **Node.js 18+** (for `starter-node`) — check: `node --version`
- **Python 3.11+** (for `starter-python`) — check: `python --version`
- **Ollama** (recommended, free, no key needed)

### Install Ollama

```bash
# macOS / Linux
curl -fsSL https://ollama.com/install.sh | sh

# Windows — download from https://ollama.com/download
```

Then pull a model (pick one):
```bash
ollama pull qwen2.5-coder:7b   # 4.7GB — best for code tasks
ollama pull llama3.1:8b        # 4.7GB — best for general tasks
ollama pull phi3:mini          # 2.3GB — fastest, smallest
```

Confirm it works:
```bash
ollama run qwen2.5-coder:7b "say hello"
```

---

## Option A — Node.js Starter

```bash
cd starter-node
npm install
cp .env.example .env
npm run dev
```

That's it. The pipeline runs Planner → Researcher using Ollama and prints the result.

### Custom goal
```bash
node index.js --goal "design a multi-tenant SaaS billing system"
```

### Add an API key (optional — for better models)
Edit `.env` and add your key:
```
OPENCODE_API_KEY=your_key_here
PROVIDER_ORDER=opencode,ollama
```

---

## Option B — Python Starter

```bash
cd starter-python
python -m venv .venv

# macOS/Linux
source .venv/bin/activate

# Windows
.venv\Scripts\activate

pip install -r requirements.txt
cp .env.example .env
python main.py
```

### Custom goal
```bash
python main.py --goal "design a multi-tenant SaaS billing system"
```

---

## Provider Setup (optional)

The starters work without any of these. Add them when you want better models.

### OpenCode Zen (free tier — best free option after Ollama)
1. Sign up at [opencode.ai](https://opencode.ai)
2. Copy your API key
3. Add to `.env`: `OPENCODE_API_KEY=your_key`
4. Set: `PROVIDER_ORDER=opencode,ollama`

### OpenRouter (pay-per-token, many free models)
1. Sign up at [openrouter.ai](https://openrouter.ai)
2. Add to `.env`: `OPENROUTER_API_KEY=your_key`
3. Set: `PROVIDER_ORDER=openrouter,ollama`

### Google Gemini
1. Get key at [aistudio.google.com](https://aistudio.google.com)
2. Add to `.env`: `GEMINI_API_KEY=your_key`
3. Set: `PROVIDER_ORDER=gemini,ollama`

### OpenAI
1. Get key at [platform.openai.com](https://platform.openai.com)
2. Add to `.env`: `OPENAI_API_KEY=your_key`
3. Set: `PROVIDER_ORDER=openai,ollama`

### Anthropic
1. Get key at [console.anthropic.com](https://console.anthropic.com)
2. Add to `.env`: `ANTHROPIC_API_KEY=your_key`
3. Set: `PROVIDER_ORDER=anthropic,ollama`

---

## Extending the Pipeline

### Add a new agent (Node.js)

```javascript
// src/agents/CoderAgent.js
'use strict';
const { BaseAgent } = require('../core/BaseAgent');

class CoderAgent extends BaseAgent {
  constructor() { super('Coder'); }

  systemPrompt() {
    return 'You are a senior software engineer. Write clean, production-ready code.';
  }

  buildPrompt(goal, context, blackboard) {
    return `Goal: ${goal}\n\nResearch summary:\n${context}\n\nWrite the implementation.`;
  }

  parseOutput(raw, blackboard) {
    blackboard.appendNote(this.name, raw.trim());
    blackboard.setArtifact('code', raw.trim());
  }
}
module.exports = { CoderAgent };
```

Then wire it into `index.js`:
```javascript
const { CoderAgent } = require('./src/agents/CoderAgent');

runner
  .addNode('Planner',    new PlannerAgent(),    [])
  .addNode('Researcher', new ResearcherAgent(), ['Planner'])
  .addNode('Coder',      new CoderAgent(),      ['Planner', 'Researcher']); // waits for both
```

### Add a new agent (Python)

```python
# src/agents/coder_agent.py
from src.core.base_agent import BaseAgent
from src.core.blackboard import Blackboard

class CoderAgent(BaseAgent):
    def __init__(self):
        super().__init__("Coder")

    def system_prompt(self) -> str:
        return "You are a senior software engineer. Write clean, production-ready code."

    def build_prompt(self, goal, context, blackboard) -> str:
        return f"Goal: {goal}\n\nResearch:\n{context}\n\nWrite the implementation."

    def parse_output(self, raw, blackboard) -> None:
        blackboard.append_note(self.name, raw.strip())
        blackboard.set_artifact("code", raw.strip())
```

Then wire into `main.py`:
```python
runner.add_node("Coder", CoderAgent(), input_from=["Planner", "Researcher"])
```

---

## Debugging

**Ollama not responding**
```bash
ollama serve          # start the server
ollama list           # confirm model is pulled
```

**"All providers failed"**
- Confirm Ollama is running: `curl http://localhost:11434/api/tags`
- Check your `.env` has `PROVIDER_ORDER=ollama`

**Enable debug logging**
```bash
# .env
LOG_LEVEL=debug
```

**Budget exceeded too quickly**
```bash
# .env
BUDGET_USD=5.00   # raise the limit
```

---

## What to build next

After the starter works, the natural extensions are in this order:

1. **Add a third agent** (Coder, Reviewer, or Formatter) — 20 minutes
2. **Add SQLite solution memory** — agents recall prior runs — 2 hours
3. **Add SSE streaming** — pipe blackboard events to a dashboard — 3 hours
4. **Add the recovery supervisor** (Part H of TEMPLATE.md) — 2 hours
5. **Swap Blackboard for Redis** — makes multi-process pipelines possible — 4 hours

See [TEMPLATE.md](TEMPLATE.md) for the full production scaffold these extensions lead to.
