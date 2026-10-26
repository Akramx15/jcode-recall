# Research notes

What we read before choosing this design, and what we took from each source. Links are the
original work; no benchmark numbers are copied or claimed here.

## Compaction and handoff

1. **"Compaction Memory: How to Stop AI Agents From Losing Context Across Compressions"**
   (sigalovskinick, public-domain gist, March 2026)
   <https://gist.github.com/sigalovskinick/e2e329bb37ecc74b9f15d5ba74ee1ee5>
   - Failure mode: after 2-3 compactions the agent loses *why* a decision was made, not just
     *what* was done, and re-proposes rejected approaches.
   - Adopted: cumulative history (never overwrite the previous handoff), decisions with
     rationale and rejected alternatives, blockers/dependencies, findings with severity,
     a pre-compact hook, and a post-compact warning that state may be stale.
   - Not adopted: an LLM-written compaction prompt. `recall` never calls a model; the
     checkpoint is structured extraction from flags or the transcript.

2. **agents-best-practices · context-memory-compaction**
   <https://github.com/DenisSergeevitch/agents-best-practices/blob/main/references/context-memory-compaction.md>
   - Adopted: separate what is durable (preferences, conventions, decisions, artifacts) from
     what is session state (current task, workflow step); keep the smallest context that
     lets the model choose the correct next action; budget explicitly.
   - `recall brief` implements the budgeted, task-scoped slice; `recall resume` implements
     the durable slice.

3. **"Context Compaction Pattern for Long-Running Agents"** (Agent Native, 2026)
   <https://www.agentnative.dev/patterns/context-compaction-pattern-for-long-running-agents>
   - Adopted: a keep-zone of verbatim, structured facts; provenance on every recalled item;
     mark recalled content as unverified so the next agent re-checks files and tests.

4. **Awesome Agent Context Compression**
   <https://github.com/YerbaPage/Awesome-Agent-Context-Compression>
   - Survey of observation, trajectory and memory compression. Confirmed the gap we target:
     most work compresses the transcript, very little preserves a *portable* decision log
     outside the agent runtime.

## Memory systems compared

5. **Mem0** <https://github.com/mem0ai/mem0> and **Letta (MemGPT)**
   <https://github.com/letta-ai/letta>
   - Both solve long-term memory with extraction + retrieval and, in Mem0's case, vector
     search. Powerful, but they add a service, an embedding model, or both.
   - Where `recall` differs: zero dependencies, no embeddings, deterministic ranking, a plain
     append-only file an agent (or a human) can read. It is deliberately narrower: project
     memory for coding sessions.

6. **claude-mem** and Claude Code's native memory tool
   - Hook-driven capture at session boundaries is the right integration point; we copied the
     hook shape (`SessionStart`, `PreCompact`, `Stop`) and the idea of one compact briefing.
   - `recall` stays agent-neutral: the same CLI and MCP server work with Jcode, Claude Code,
     Codex, opencode, or a shell script.

7. **Zep / Graphiti** <https://github.com/getzep/graphiti>
   - Temporal knowledge graphs are the right answer when relationships between entities
     matter. Not worth a graph database for "which decisions govern this repo"; timestamps,
     supersedes links and recency ranking cover the coding-session case.

## Retrieval

8. **BM25** (Robertson & Zaragoza, *The Probabilistic Relevance Framework*) and the
   `rank_bm25` reference implementations.
   - Adopted: per-record term frequency, inverse document frequency, length normalisation,
     plus recency half-life, importance, pinning and same-project boost.
   - Arabic normalisation (diacritics, tatweel, alef/ya/ta-marbuta unification, Arabic-Indic
     digits) follows Unicode NFKC plus the common search-normalisation rules used by Arabic
     IR systems.

## Design conclusions

- The unit of memory is a **short, typed, sourced record**, not a chat blob.
- The agent needs **two different reads**: a durable briefing (resume) and a task-scoped one
  (brief). One giant dump serves neither.
- Compaction is a **state-transfer event**: write before it, read after it, and mark what was
  read as unverified.
- Everything must work **offline, deterministically, and without a model call**, otherwise the
  memory layer becomes another thing that can fail during an incident.

See `DESIGN.md` for the resulting architecture and `AGENT-PROTOCOL.md` for the six-line
protocol agents should follow.
