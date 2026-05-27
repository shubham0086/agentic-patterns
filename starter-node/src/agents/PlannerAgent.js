'use strict';

const { BaseAgent } = require('../core/BaseAgent');

class PlannerAgent extends BaseAgent {
  constructor() {
    super('Planner');
  }

  systemPrompt() {
    return `You are a planning agent. Given a goal, produce a concise structured plan.

Output a JSON object with this exact shape:
{
  "objective": "one-sentence restatement of the goal",
  "steps": ["step 1", "step 2", "step 3"],
  "constraints": ["constraint 1", "constraint 2"],
  "success_criteria": "how to know when done"
}

Output ONLY the JSON. No explanation before or after.`;
  }

  buildPrompt(goal, context, blackboard) {
    return `Goal: ${goal}\n\nCreate a structured plan.`;
  }

  parseOutput(raw, blackboard) {
    const plan = BaseAgent.cleanJSON(raw);

    if (plan) {
      blackboard.setArtifact('plan', plan);
      blackboard.appendNote(this.name,
        `Objective: ${plan.objective}\n` +
        `Steps:\n${plan.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}\n` +
        `Success: ${plan.success_criteria}`
      );
    } else {
      // Graceful fallback — store raw output if JSON parse fails
      blackboard.appendNote(this.name, raw.trim());
    }
  }
}

module.exports = { PlannerAgent };
