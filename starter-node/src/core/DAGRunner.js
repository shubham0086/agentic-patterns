'use strict';

/**
 * DAGRunner — executes agents in topological order.
 * Implements Kahn's algorithm for dependency resolution.
 * See: docs/01-dag-vs-linear.md
 */
class DAGRunner {
  constructor() {
    this.nodes = new Map(); // id → { agent, inputFrom: [] }
    this.edges = [];        // [from, to]
  }

  addNode(id, agent, inputFrom = []) {
    this.nodes.set(id, { agent, inputFrom });
    inputFrom.forEach(dep => this.edges.push([dep, id]));
    return this;
  }

  topologicalOrder() {
    const inDegree = new Map();
    const adj = new Map();

    for (const id of this.nodes.keys()) {
      inDegree.set(id, 0);
      adj.set(id, []);
    }

    for (const [from, to] of this.edges) {
      adj.get(from).push(to);
      inDegree.set(to, inDegree.get(to) + 1);
    }

    const queue = [];
    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    const order = [];
    while (queue.length > 0) {
      const node = queue.shift();
      order.push(node);
      for (const dep of adj.get(node)) {
        const newDeg = inDegree.get(dep) - 1;
        inDegree.set(dep, newDeg);
        if (newDeg === 0) queue.push(dep);
      }
    }

    if (order.length !== this.nodes.size) {
      throw new Error('Cycle detected in agent dependency graph');
    }

    return order;
  }

  async run(blackboard) {
    const order = this.topologicalOrder();
    const log = process.env.LOG_LEVEL === 'debug'
      ? (...a) => console.log('[dag]', ...a)
      : () => {};

    log('Execution order:', order.join(' → '));

    for (const id of order) {
      const { agent, inputFrom } = this.nodes.get(id);

      blackboard.setStatus(id, 'running');
      console.log(`\n▶  ${id}`);

      try {
        // Pass only the notes this agent actually depends on
        const context = inputFrom.length > 0
          ? blackboard.getNotesFor(inputFrom)
          : '';

        await agent.execute(blackboard, context);
        blackboard.setStatus(id, 'done');
        console.log(`✓  ${id}`);
      } catch (err) {
        blackboard.setStatus(id, 'failed');
        console.error(`✗  ${id}: ${err.message}`);
        throw err;
      }
    }
  }
}

module.exports = { DAGRunner };
