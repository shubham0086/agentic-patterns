'use strict';

const crypto = require('crypto');

// ── Provider configuration ─────────────────────────────────────────────────

const PROVIDER_CONFIGS = {
  ollama: {
    baseUrl: process.env.OLLAMA_BASE_URL || 'http://localhost:11434',
    model: process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b',
    timeout: 90_000,
    requiresKey: false,
  },
  opencode: {
    baseUrl: 'https://opencode.ai/zen/v1',
    model: process.env.OPENCODE_MODEL || 'minimax-m2.5-free',
    timeout: 30_000,
    requiresKey: true,
    keyEnv: 'OPENCODE_API_KEY',
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    model: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free',
    timeout: 45_000,
    requiresKey: true,
    keyEnv: 'OPENROUTER_API_KEY',
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: process.env.GEMINI_MODEL || 'gemini-2.0-flash',
    timeout: 60_000,
    requiresKey: true,
    keyEnv: 'GEMINI_API_KEY',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    timeout: 60_000,
    requiresKey: true,
    keyEnv: 'OPENAI_API_KEY',
  },
  anthropic: {
    baseUrl: 'https://api.anthropic.com/v1',
    model: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001',
    timeout: 60_000,
    requiresKey: true,
    keyEnv: 'ANTHROPIC_API_KEY',
  },
};

// Session-level circuit breaker — shared across all agent instances
const _exhausted = new Set();
const _responseCache = new Map();

/**
 * BaseAgent — base class for all agents.
 *
 * Subclass and implement:
 *   systemPrompt()  → string
 *   buildPrompt(goal, context, blackboard) → string
 *   parseOutput(raw, blackboard) → void
 */
class BaseAgent {
  constructor(name) {
    this.name = name;
    this.providerOrder = (process.env.PROVIDER_ORDER || 'ollama')
      .split(',')
      .map(p => p.trim())
      .filter(p => PROVIDER_CONFIGS[p]);
  }

  // ── Override in subclass ───────────────────────────────────────────────────

  systemPrompt() {
    return 'You are a helpful AI assistant. Respond concisely and accurately.';
  }

  buildPrompt(goal, context, blackboard) {
    return context
      ? `Goal: ${goal}\n\nContext from prior agents:\n${context}\n\nProvide your analysis.`
      : `Goal: ${goal}\n\nProvide your analysis.`;
  }

  parseOutput(raw, blackboard) {
    blackboard.appendNote(this.name, raw.trim());
  }

  // ── Core execution ─────────────────────────────────────────────────────────

  async execute(blackboard, context = '') {
    const sys = this.systemPrompt();
    const prompt = this.buildPrompt(blackboard.goal, context, blackboard);

    // Cache check — saves tokens on identical prompts within a session
    const cacheKey = crypto.createHash('sha256')
      .update(sys + '\x00' + prompt)
      .digest('hex');

    if (_responseCache.has(cacheKey)) {
      const cached = _responseCache.get(cacheKey);
      console.log(`  [${this.name}] cache hit`);
      this.parseOutput(cached, blackboard);
      return;
    }

    const raw = await this._callWithFallover(sys, prompt, blackboard);
    _responseCache.set(cacheKey, raw);
    this.parseOutput(raw, blackboard);
  }

  // ── Provider routing ───────────────────────────────────────────────────────

  async _callWithFallover(systemPrompt, prompt, blackboard) {
    for (const provider of this.providerOrder) {
      if (_exhausted.has(provider)) continue;

      const cfg = PROVIDER_CONFIGS[provider];

      if (cfg.requiresKey && !process.env[cfg.keyEnv]) {
        continue; // skip providers without keys configured
      }

      try {
        console.log(`  [${this.name}] trying ${provider}/${cfg.model}`);
        const result = await this._call(provider, cfg, systemPrompt, prompt);
        const cost = this._estimateCost(provider, prompt, result);
        blackboard.recordCost(this.name, cost);
        return result;
      } catch (err) {
        console.warn(`  [${this.name}] ${provider} failed: ${err.message}`);

        // Hard failures — skip this provider entirely
        if (err.status === 401 || err.status === 403) {
          _exhausted.add(provider);
        }
        // Soft failures (rate limit, timeout) — try next in chain
      }
    }

    throw new Error(`[${this.name}] All providers failed or unconfigured. Install Ollama and run: ollama pull qwen2.5-coder:7b`);
  }

  async _call(provider, cfg, systemPrompt, prompt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeout);

    try {
      if (provider === 'ollama') {
        return await this._callOllama(cfg, systemPrompt, prompt, controller.signal);
      }
      if (provider === 'anthropic') {
        return await this._callAnthropic(cfg, systemPrompt, prompt, controller.signal);
      }
      return await this._callOpenAICompat(provider, cfg, systemPrompt, prompt, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async _callOllama(cfg, systemPrompt, prompt, signal) {
    const res = await fetch(`${cfg.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: cfg.model,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
      }),
      signal,
    });

    if (!res.ok) {
      const err = new Error(`Ollama ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    return data.message?.content || '';
  }

  async _callOpenAICompat(provider, cfg, systemPrompt, prompt, signal) {
    const key = process.env[cfg.keyEnv];
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
      }),
      signal,
    });

    if (!res.ok) {
      const err = new Error(`${provider} ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  }

  async _callAnthropic(cfg, systemPrompt, prompt, signal) {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal,
    });

    if (!res.ok) {
      const err = new Error(`anthropic ${res.status}`);
      err.status = res.status;
      throw err;
    }

    const data = await res.json();
    return data.content?.[0]?.text || '';
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  // Never use JSON.parse() on raw LLM output — use this instead.
  static cleanJSON(raw) {
    try {
      const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      const cleaned = match ? match[1] : raw;
      return JSON.parse(cleaned.trim());
    } catch {
      return null;
    }
  }

  _estimateCost(provider, prompt, result) {
    // Rough token estimate: 1 token ≈ 4 chars
    const tokens = Math.ceil((prompt.length + result.length) / 4);
    const rates = {
      ollama: 0,
      opencode: 0,
      openrouter: 0.0000002,
      gemini: 0.00000015,
      openai: 0.00000015,
      anthropic: 0.00000025,
    };
    return tokens * (rates[provider] || 0);
  }
}

module.exports = { BaseAgent };
