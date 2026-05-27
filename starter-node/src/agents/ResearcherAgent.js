'use strict';

const { BaseAgent } = require('../core/BaseAgent');

class ResearcherAgent extends BaseAgent {
  constructor() {
    super('Researcher');
  }

  systemPrompt() {
    return `You are a research and synthesis agent. Given a goal and a plan, provide a thorough research summary.

Focus on:
- Key concepts and definitions
- Current state of the field (as of your training data)
- Practical considerations and trade-offs
- What someone implementing this would need to know

Be specific and factual. Avoid generic advice.
Write in clear prose, 3-5 paragraphs.`;
  }

  buildPrompt(goal, context, blackboard) {
    const plan = blackboard.artifacts.plan;
    const planSummary = plan
      ? `Plan:\n${plan.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
      : context;

    return `Goal: ${goal}\n\n${planSummary}\n\nProvide a research summary to inform implementation.`;
  }

  parseOutput(raw, blackboard) {
    blackboard.appendNote(this.name, raw.trim());
    blackboard.setArtifact('research_summary', raw.trim());
  }
}

module.exports = { ResearcherAgent };
