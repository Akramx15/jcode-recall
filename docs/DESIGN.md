# Design notes

## What this is

`jcode-recall` is a small, local, append-only memory store for coding agents. Its job is not to be a
general knowledge base. Its job is to survive context compaction: keep the few facts and decisions
that a coding session depends on, and hand them back at the moment a fresh context begins.

Everything is deliberate: no embeddings, no model calls, no server, no daemon, no database engine.
A project's memory is a text file you can read, diff, copy, back up and delete with normal tools.

## Why not a vector database

Vector databases solve semantic similarity over large corpora. That is a real problem, but it is not
this problem.

1. **Determinism.** Given the same records and query, the same ranking is produced every time. Agent
   memory is consulted before actions; flaky retrieval makes behaviour unreproducible. Embedding
   models change between versions and providers.
2. **Zero dependencies.** A coding agent may run on a locked-down machine, in CI, or on a user's
   laptop with no package manager access. `node:fs`, `node:crypto`, `node:path` and the language
   runtime are enough. No native module, no vector index, no Python sidecar.
3. **Speed at the relevant scale.** A project accumulates hundreds to a few thousand memories, not
   millions of documents. Reading a handful of JSONL files and scoring them in-process is
   milliseconds of work. An ANN index is unnecessary machinery at this size.
4. **Explainability.** BM25 scores can be inspected term by term. A user can see why a memory
   surfaced (matched terms, tag, file, recency, importance, pin). Debugging an agent's wrong belief
   is possible without instrumenting an embedding space.
5. **Offline and private by construction.** No model download, no API key, no network path. The tool
   cannot leak data because it has no channel to do so.
6. **Durability.** Append-only JSONL plus fsync and a cross-process lock is easy to reason about.
   A vector store's internal format is not something a user can repair with a text editor.

The tradeoff is honest: lexical retrieval misses paraphrase. Arabic normalization, tag and file
signals, importance, pins and the `--literal` mode mitigate this. When a task genuinely needs
semantic recall over a huge corpus, pair this tool with a real search system. Do not turn a
1000-record project memory into a vector infrastructure project.

## Data model

```text
Record
  id            string, timestamp-based with random suffix
  ts            ISO-8601 UTC
  project       human label (basename of the canonical root)
  projectPath   canonical root, forward slashes, original case
  projectKey    canonical comparison/hash key, lowercased on Windows
  kind          fact | decision | preference | task | artifact | handoff | snippet
  text          the memory, trimmed, max 200k characters
  tags[]        up to 24 short tags
  files[]       up to 64 related paths, normalized to forward slashes
  importance    1..5, default 3
  session       agent session id
  source        cli | mcp | hook
  pinned        boolean
  data          optional structured payload (checkpoints)
  supersededBy  optional id of the replacing record
```

Derived ops in the same JSONL stream:

```json
{"_op":"update","id":"r...","patch":{"pinned":true},"ts":"..."}
{"_op":"delete","id":"r...","ts":"..."}
```

Readers fold records and ops in file order. Writers never rewrite a line. A crash mid-append can at
worst leave a partial final line, which is counted and skipped on the next read.

### Project identity

The original prototype keyed data files by project basename. That is a correctness bug: two unrelated
repositories named `app`, or two directories named `src`, would share memory and leak facts across
projects. This version separates:

- `project` is a **label** for humans.
- `projectKey` is the **identity**: the absolute git top-level (`git rev-parse --show-toplevel` when
  a `.git` is present in an ancestor) or the absolute cwd otherwise, normalized to forward slashes
  and lowercased on Windows.
- The file name is a hash of `projectKey`, so collisions require a canonical path collision.
- Implicit commands (no `--project`) filter by exact `projectKey`. An explicit `--project <name>`
  matches labels across projects and renders `@path` for every record so mixed provenance is visible.
- `global.jsonl` is intentionally shared and marked `global` in briefings.

## Retrieval

BM25 with `k1 = 1.2`, `b = 0.75` over a weighted token multiset:

- text tokens: weight 1
- tag tokens: duplicated (weight 2)
- file tokens: each path is split on separators, plus a joined path form

Then a multiplicative boost:

```text
factor = (1 + 0.6 * 0.5^(ageDays / 30))        recency, 30-day half-life
       * (1 + 0.15 * (importance - 3))          importance 1..5
       * (1.25 if same projectKey)               same-project preference
       * (1.6 if pinned)                         explicit user intent
       * (0.2 if superseded)                     visible only when requested
```

Literal mode normalizes both sides and counts substring occurrences, with the same boosts.

### Unicode and Arabic

Normalization runs before tokenization:

- NFKC compatibility folding
- lowercase (Latin; Arabic is caseless)
- remove Arabic diacritics (U+0610..U+061A, U+064B..U+065F, U+0670, U+06D6..U+06ED) and tatweel
- unify alef forms (أ إ آ ٱ) to ا, ى to ي, ة to ه, ؤ to و, ئ to ي
- convert Arabic-Indic and Extended Arabic-Indic digits to ASCII digits
- tokenize runs of `\p{L}\p{N}+` and keep CJK runs intact

This makes `قاعدة` and `قاعده`, or `أحمد` and `احمد` with or without harakat, retrieve the same
memory. Stop words are a short curated Arabic and English list only; aggressive stemming was rejected
because it harms code identifiers.

## Token budgets

Budgets are enforced by construction, not by hope. Every renderer appends whole entries only when the
estimated token count of the result stays within the budget. The final safety net truncates at
`budget * 4` characters. The estimate is `ceil(characters / 4)`, documented as approximate. For Arabic
this can underestimate real tokens, so budgets are a soft ceiling in practice; the hard guarantee is
the character cap.

## Context survival

A checkpoint is a `handoff` record with a plain-text rendering and a structured `data` payload:

```json
{
  "goal": "...",
  "constraints": ["..."],
  "decisions": ["..."],
  "files": ["..."],
  "commands": [{"command": "npm test", "result": "5 passing", "status": "ok"}],
  "openQuestions": ["..."],
  "nextSteps": ["..."],
  "blockers": ["..."],
  "summary": "..."
}
```

Extraction from transcripts is rule based. It splits lines and sentences, then classifies them with
multilingual keyword sets (English and Arabic) for constraints, decisions, next steps, blockers and
questions. Commands come from tool calls, paired in order with tool results, and status is inferred
from explicit pass/fail signals (`0 failed`, `passed`, `exit code 1`, `traceback`). Every stored
string is a substring of the input; nothing is summarized or generated. Empty input produces an
error rather than an invented handoff.

On resume, the latest checkpoint is always labelled `unverified`, and `stale` after 7 days. Pinned
records are labelled stale after 60 days. The briefing ends with unfinished items, also marked
unverified, so a fresh agent knows to check the working tree.

## Concurrency and durability

- A `.lock` file is created with `wx` (exclusive create) beside the data file.
- Contenders sleep with `Atomics.wait` and retry. Locks older than 15 seconds are treated as stale.
- The append itself is one buffered write followed by `fsync` (best effort).
- Dedupe happens inside the lock, so two processes cannot both append the same normalized text.
- Reads tolerate CRLF, BOM, empty lines, malformed JSON and a truncated final line.

This is a single-machine design. It does not attempt distributed coordination.

## MCP

`recall mcp` is a hand-written JSON-RPC 2.0 server for MCP `2024-11-05`:

- newline-delimited messages, buffered so partial reads and multiple messages per chunk work
- `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`
- unknown methods return `-32601`; malformed JSON returns `-32700`
- notifications never produce responses
- tool failures return `isError: true` text content instead of crashing
- stdout carries JSON-RPC only; diagnostics go to stderr

No SDK is used because the protocol surface needed here is small and stable, and a dependency would
violate the zero-dependency constraint.

## Comparison with other memory systems

These are public projects with different goals. This section describes their stated approach from
their public repositories, not measured performance. No benchmarks were run for this comparison and
none are claimed.

| Project | Primary approach | How `jcode-recall` differs |
|---|---|---|
| [mem0](https://github.com/mem0ai/mem0) | A memory layer for AI applications that extracts and consolidates memories, typically using LLM calls plus vector (and graph) storage, with hosted and self-hosted options. | No LLM extraction, no embeddings, no vector store, no service. Records are explicit and deterministic; retrieval is BM25. |
| [Letta](https://github.com/letta-ai/letta) (formerly MemGPT) | A stateful agent framework and server that manages memory blocks and archival memory inside an agent runtime. | Not an agent runtime. A single CLI plus MCP server that any harness can call. Storage is plain JSONL. |
| [claude-mem](https://github.com/thedotmack/claude-mem) | A Claude Code plugin that captures session activity and compresses it into a local memory store, using an LLM for compression in its pipeline. | Harness-agnostic and LLM-free. Prefers explicit checkpoints and short records over automatic summarization. |

The shared lesson from these systems is that context management must be automatic to be used. The
difference here is a deliberate constraint: keep the mechanism inspectable and deterministic, and let
hooks provide the automation.

## Non-goals

- Semantic search over a large personal corpus
- Multi-user or cloud sync
- Encryption at rest
- Automatic compaction of the JSONL log
- Replacing source control, issue trackers or documentation

## References

- Robertson and Zaragoza, "The Probabilistic Relevance Framework: BM25 and Beyond" (2009).
- MCP specification `2024-11-05`: <https://modelcontextprotocol.io/specification/2024-11-05>
- Unicode Standard Annex #15, Normalization Forms.
- Jcode: <https://github.com/1jehuang/jcode>
