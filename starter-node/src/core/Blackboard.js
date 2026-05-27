'use strict';

/**
 * Blackboard — centralized shared state for the agent pipeline.
 *
 * Rules:
 * - Agents never mutate state directly. They call Blackboard methods.
 * - notes[] is append-only. No agent overwrites another's notes.
 * - All changes emit an event for observability.
 */
class Blackboard {
  constructor(goal) {
    this._state = {
      goal,
      notes: [],        // append-only list of agent outputs
      artifacts: {},    // key → value (files, results, structured data)
      costs: {},        // agentName → USD spent
      status: {},       // agentName → 'pending' | 'running' | 'done' | 'failed'
    };
    this._listeners = [];
    this._totalCost = 0;
    this._budgetUsd = parseFloat(process.env.BUDGET_USD || '0.50');
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  get goal() { return this._state.goal; }
  get notes() { return [...this._state.notes]; }
  get artifacts() { return { ...this._state.artifacts }; }
  get totalCost() { return this._totalCost; }

  getNotesFor(agentNames) {
    return this._state.notes
      .filter(n => agentNames.includes(n.agent))
      .map(n => `[${n.agent}]\n${n.content}`)
      .join('\n\n');
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  appendNote(agentName, content) {
    const note = { agent: agentName, content, timestamp: Date.now() };
    this._state.notes.push(note);
    this._emit('note', note);
  }

  setArtifact(key, value) {
    this._state.artifacts[key] = value;
    this._emit('artifact', { key });
  }

  setStatus(agentName, status) {
    this._state.status[agentName] = status;
    this._emit('status', { agent: agentName, status });
  }

  recordCost(agentName, usd) {
    this._state.costs[agentName] = (this._state.costs[agentName] || 0) + usd;
    this._totalCost += usd;
    this._emit('cost', { agent: agentName, usd, total: this._totalCost });

    if (this._totalCost > this._budgetUsd) {
      this._emit('budget_exceeded', { spent: this._totalCost, limit: this._budgetUsd });
      throw new Error(`Budget exceeded: $${this._totalCost.toFixed(4)} > $${this._budgetUsd}`);
    }
  }

  // ── Observability ─────────────────────────────────────────────────────────

  onEvent(listener) {
    this._listeners.push(listener);
  }

  _emit(type, data) {
    const event = { timestamp: new Date().toISOString(), type, ...data };
    this._listeners.forEach(l => l(event));
  }

  summary() {
    return {
      goal: this._state.goal,
      agents: this._state.status,
      totalCost: `$${this._totalCost.toFixed(4)}`,
      notesCount: this._state.notes.length,
      artifacts: Object.keys(this._state.artifacts),
    };
  }
}

module.exports = { Blackboard };
