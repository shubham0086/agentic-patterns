'use strict';

require('dotenv').config();

const { Blackboard } = require('./src/core/Blackboard');
const { DAGRunner } = require('./src/core/DAGRunner');
const { PlannerAgent } = require('./src/agents/PlannerAgent');
const { ResearcherAgent } = require('./src/agents/ResearcherAgent');

async function main() {
  const goal = process.argv.includes('--goal')
    ? process.argv[process.argv.indexOf('--goal') + 1]
    : 'Research and explain the key patterns for building production multi-agent AI systems';

  console.log('━'.repeat(60));
  console.log(' Agentic Patterns Starter');
  console.log('━'.repeat(60));
  console.log(`Goal: ${goal}\n`);

  const blackboard = new Blackboard(goal);

  // Log all events to console in debug mode
  if (process.env.LOG_LEVEL === 'debug') {
    blackboard.onEvent(e => console.log('[event]', JSON.stringify(e)));
  }

  // ── Define the pipeline as a DAG ──────────────────────────────────────────
  //
  //   Planner ──→ Researcher
  //
  // Researcher waits for Planner. Planner has no dependencies.
  // To add more agents: runner.addNode('Coder', new CoderAgent(), ['Planner', 'Researcher'])

  const runner = new DAGRunner();
  runner
    .addNode('Planner',    new PlannerAgent(),    [])
    .addNode('Researcher', new ResearcherAgent(), ['Planner']);

  const start = Date.now();

  try {
    await runner.run(blackboard);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const summary = blackboard.summary();

    console.log('\n' + '━'.repeat(60));
    console.log(' Pipeline Complete');
    console.log('━'.repeat(60));
    console.log(`Time:  ${elapsed}s`);
    console.log(`Cost:  ${summary.totalCost}`);
    console.log(`Notes: ${summary.notesCount} entries`);
    console.log('\n── Research Summary ──────────────────────────────────────\n');
    console.log(blackboard.artifacts.research_summary || '(no summary produced)');
    console.log('\n' + '━'.repeat(60));

  } catch (err) {
    if (err.message.includes('Budget exceeded')) {
      console.error('\n[budget] Pipeline stopped:', err.message);
    } else {
      console.error('\n[error] Pipeline failed:', err.message);
      process.exit(1);
    }
  }
}

main();
