# Changelog

## 1.1.0

Automatic capture from Jcode sessions.

- `recall import-session` reads a Jcode `.json` snapshot, a `.journal.jsonl`, or a
  directory of sessions and writes one structured handoff plus any explicit user
  preferences. Deterministic extraction only: no LLM, no invented text.
- `recall autosave [--once|--watch]` imports changed sessions, scoped by default to
  the current project and the last 7 days (`--all`, `--since` to widen). A file is
  imported once; a ledger and a single-process lock prevent duplicates.
- Imported content is redacted, reasoning blocks and tool schemas are ignored, and
  tool output is never copied into a checkpoint.
- New MCP tool `recall_import_session` (9 tools total).
- `recall_resume` now falls back to the most recently active project with a visible
  note when the current directory has no records (Jcode Desktop can launch with cwd
  set to its install folder). Explicit `--project`/`--all` behavior is unchanged.
- Resume keeps the goal visible at small token budgets (120/250/400) instead of
  dropping the whole checkpoint body.
- 87 tests (was 60); MCP smoke covers the new tool.

## 1.0.0

First release: zero-dependency CLI and MCP server, append-only JSONL per canonical
project, Arabic-aware BM25, checkpoints, budgeted resume/brief, hooks, Windows
installer.
