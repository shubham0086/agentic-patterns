# Pattern 05 — RAG That Doesn't Suck

**Problem**: Naive RAG retrieves chunks by semantic similarity (embedding search), but agents often get irrelevant results. A search for "How do we handle user authentication?" returns a chunk about "authentication logs" (semantically similar, useless in context). Or RAG returns 10 chunks when the agent only needs 1, wasting tokens and confusing the LLM.

**Solution**: Layer three strategies—SHA-256 response caching (avoid recompute), semantic filtering by recency + role (exclude outdated/irrelevant chunks), and hybrid search (exact-match first, fallback to semantic). Together, they cut noise and token waste by 80%.

---

## The Problem: Vanilla Vector Search Is Inefficient

Typical RAG flow:
```
Query: "How do we handle distributed transactions?"
  ↓
Embedding Search (top-10 similar chunks)
  ↓
Results:
  1. "In our system, distributed transactions use Saga pattern with..."  ✅ Relevant
  2. "PostgreSQL transactions have ACID guarantees..."               ⚠️ Tangential
  3. "Payment transaction IDs must be unique..."                    ❌ Not relevant
  4. "Database transaction logs are archived daily..."              ❌ Not relevant
  5. ... (6 more irrelevant chunks)
  ↓
Agent gets confused, ignores results, or wastes tokens reading noise.
```

**Root causes**:
- Vector embeddings capture surface similarity, not intent.
- No temporal filtering (old solutions as relevant as fresh).
- No role-aware filtering (ops logs equally weighted with architecture notes).
- No exact-match fast path (expensive embedding for every query).

---

## The Solution: Three-Layer Filtering

### Layer 1: SHA-256 Cache (Avoid Recompute)

Most agent queries are repetitive: "What's the architecture?" appears in 3 different pipeline runs. Don't re-embed/search; cache the result.

```javascript
class RAGCache {
  constructor() {
    this.cache = new Map();  // hash -> { embedding, results, timestamp }
  }

  computeHash(query, agentRole, intent) {
    // Hash = (query + role + intent) to account for context
    // Example: same query asked by Architect vs Coder may need different context
    const key = `${query}|${agentRole}|${intent}`;
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  async retrieve(query, agentRole = 'general', intent = 'info', db) {
    const hash = this.computeHash(query, agentRole, intent);

    // Cache hit?
    if (this.cache.has(hash)) {
      const cached = this.cache.get(hash);
      const age = Date.now() - cached.timestamp;

      if (age < 3600000) {  // 1 hour TTL
        console.log(`[RAG Cache] Hit (age: ${age}ms)`);
        return { results: cached.results, cached: true };
      }
    }

    // Cache miss: compute embedding + search
    console.log(`[RAG Cache] Miss, computing...`);
    const results = await this._semanticSearch(query, db);

    // Store in cache
    this.cache.set(hash, {
      embedding: null,  // optional: store embedding for later reuse
      results,
      timestamp: Date.now()
    });

    return { results, cached: false };
  }

  clearOlderThan(ageSec) {
    const cutoff = Date.now() - (ageSec * 1000);
    for (const [hash, entry] of this.cache.entries()) {
      if (entry.timestamp < cutoff) {
        this.cache.delete(hash);
      }
    }
  }
}
```

**Cost savings**: Repeated queries = 0 tokens. Cache miss cost amortized over N repeats.

---

### Layer 2: Semantic Filtering (Exclude Noise)

After embedding search returns candidates, filter by:
1. **Recency**: Exclude solutions >7 days old (stale)
2. **Confidence**: Exclude unverified solutions (<60% confidence)
3. **Agent role**: Researcher cares about breadth; Coder cares about implementation
4. **Source type**: Architecture docs ranked higher than logs

```javascript
class SemanticFilter {
  async filterResults(candidates, db, agentRole, maxAge=7) {
    // Candidate = { content, source_file, timestamp, confidence, type }

    let filtered = candidates
      .filter(c => {
        // 1. Recency
        const ageDays = (Date.now() - c.timestamp) / (24 * 3600 * 1000);
        if (ageDays > maxAge) return false;

        // 2. Confidence
        if (c.confidence < 60) return false;

        // 3. Role-based filtering
        if (agentRole === 'Coder' && c.type === 'log') return false;
        if (agentRole === 'Researcher' && c.type === 'implementation') return false;

        return true;
      })
      .sort((a, b) => {
        // Rank by (confidence × recency)
        const scoreA = a.confidence * (1 - (Date.now() - a.timestamp) / (30 * 24 * 3600 * 1000));
        const scoreB = b.confidence * (1 - (Date.now() - b.timestamp) / (30 * 24 * 3600 * 1000));
        return scoreB - scoreA;
      })
      .slice(0, 3);  // Top 3 results max

    return filtered;
  }
}
```

**Cost savings**: 10 chunks → 3 chunks = 70% fewer tokens in context.

---

### Layer 3: Hybrid Search (Exact + Semantic)

Try exact match (full-text search) first; fallback to semantic only if needed.

```javascript
class HybridSearch {
  constructor(fullTextIndex, vectorDB) {
    this.fullText = fullTextIndex;  // e.g., SQLite FTS5
    this.vectors = vectorDB;         // e.g., Pinecone, pgvector
  }

  async search(query, db, agentRole) {
    // 1. Try exact match (fast, zero embedding cost)
    const exactMatches = await this.fullText.search(query);

    if (exactMatches.length > 0) {
      console.log(`[RAG] Exact match found, returning ${exactMatches.length} results`);
      return exactMatches.slice(0, 5);
    }

    // 2. Fall back to semantic search (costs tokens)
    console.log(`[RAG] No exact match, computing embedding...`);
    const embedding = await this._embed(query);  // ~100 tokens
    const semanticMatches = await this.vectors.search(embedding, topK=5);

    // 3. Apply semantic filter
    const filter = new SemanticFilter();
    const filtered = await filter.filterResults(
      semanticMatches,
      db,
      agentRole,
      maxAge=7
    );

    return filtered;
  }
}
```

**Why it works**:
- Exact match costs 0 tokens (just SQL LIKE query)
- Semantic search only on misses (~20% of queries)
- Overall embedding cost drops from 100% to 20% of queries

---

## Real Example: SDLC Memory Routing

The agentic-patterns starters implement this pattern in `memory/routing.js`:

**Scenario 1**: Agent queries "How does Blackboard work?"
- SHA-256 cache: `hash = SHA256("How does Blackboard work?|Coder|info")`
- Exact match: SQLite FTS5 finds `memory/reality/blackboard-api.md`
- Return immediately (0 tokens, 50ms)

**Scenario 2**: Agent queries "Best practice for error handling in async agents"
- SHA-256 cache: Miss (first time)
- Exact match: No results
- Semantic search: Embed query (100 tokens)
- Semantic filter: Return top-1 (99.5% confidence, <2 days old, type=bestpractice)
- Cache result
- Return (100 tokens, 1.2s)

**Scenario 3**: Same agent queries "Best practice for error handling..." again 5 minutes later
- SHA-256 cache: Hit
- Return cached result immediately (0 tokens, 50ms)

---

## Observability & Tuning

Monitor in reality files:

```yaml
memory/reality/rag-performance.yaml:
  working:
    - claim: "Exact-match searches cost 0 tokens"
      verify: "grep -c 'exact_match=true' rag.log"
    - claim: "Cache hit rate >60% for repeated queries"
      verify: "jq '.cache_hit_rate' rag-stats.json"
    - claim: "Semantic filter reduces noise by 70%"
      verify: "jq '.avg_results_before_filter / .avg_results_after_filter' rag-stats.json"
  stubs:
    - "Semantic re-ranking (use cross-encoder for top-3)"
    - "Time-decay function (recent > old)"
```

Add metrics to RAG class:

```javascript
class RAGMetrics {
  constructor() {
    this.exactMatches = 0;
    this.semanticSearches = 0;
    this.cacheHits = 0;
    this.totalQueries = 0;
  }

  log() {
    return {
      cache_hit_rate: this.cacheHits / this.totalQueries,
      exact_match_rate: this.exactMatches / this.totalQueries,
      semantic_rate: this.semanticSearches / this.totalQueries,
      avg_embedding_cost: (this.semanticSearches * 100) / this.totalQueries
    };
  }
}
```

---

## Trade-Offs

| Benefit | Cost |
|---------|------|
| Exact match = zero token cost | Setup (FTS5 index, vector DB) |
| Cache hit avoids recompute | Cache staleness (1-hour TTL) |
| Semantic filter reduces noise 70% | Manual tuning of role/confidence filters |
| Hybrid search = fast + accurate | Embedding API costs (but ~20% of queries) |

**Typical token savings**:
- Naive RAG: 100 queries × 2000 tokens (10 chunks) = 200K tokens
- Hybrid RAG: 100 queries × 500 tokens avg (3 chunks, 20 embeddings) = 50K tokens
- **Savings: 75% token reduction**

---

## When to Use

**Use hybrid RAG**:
- Agents query the same docs repeatedly
- Large knowledge base (>1000 documents)
- Cost-sensitive environments (pay-per-token)
- Multi-day pipelines (cache hits accrue)

**Skip RAG entirely**:
- Tiny knowledge base (<100 docs, fits in context)
- One-shot queries (no cache hits possible)
- Real-time data (cache staleness unacceptable)

---

## Summary

Good RAG is three layers:
1. **Cache** (SHA-256) to avoid recompute
2. **Filter** (recency + role + confidence) to exclude noise
3. **Hybrid** (exact first, semantic fallback) to save embedding cost

Together: 75% token savings, faster queries, less LLM confusion.

Implement once, benefit for every agent that calls RAG.
