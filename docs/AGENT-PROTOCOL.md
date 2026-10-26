# Agent protocol

The exact protocol, seven lines. Follow it literally.

```text
1. On session start, call recall_resume before doing anything else.
2. Before context compaction, call recall_checkpoint with goal, decisions, files and next steps.
3. When unsure about a past decision, call recall_search instead of guessing.
4. Never store secrets, credentials, tokens or private keys.
5. Store decisions together with their rationale.
6. Keep every entry short and specific.
7. If resume says it is showing another project, verify the path before acting.
```

## Why each line exists

**1. Resume first.** A compacted context looks complete but is not. `recall_resume` returns the
pinned facts, the latest checkpoint, decisions and open tasks in one budgeted block. Reading it costs
far less than rediscovering the project state.

**2. Checkpoint before compaction.** Compaction is lossy and happens without warning. A checkpoint
written before it is the only reliable handoff. Include the goal, decisions, files touched, commands
and tests with their results, open questions, next steps and blockers.

**3. Search instead of guessing.** A confident wrong assumption about a prior decision is expensive.
`recall_search` is cheap and returns provenance (id, timestamp, importance, score, project path).

**4. Never store secrets.** The store is plain text on disk and may be exported or pasted into a
prompt. `recall_remember` refuses secret-looking text unless forced; checkpoints redact matches. Do
not work around this.

**5. Decisions need rationale.** "Use Postgres" is weak. "Use Postgres 16 because the analytics
queries need window functions and the team already operates it" survives contact with a future agent
who might otherwise undo the decision.

**6. Short entries.** Retrieval and budgets work on compact records. One fact or decision per record.
Prefer 200 characters over 2000. Put long material in files and reference the paths.

**7. Verify a fallback project.** Jcode Desktop sometimes starts the agent from an app install
folder rather than the repository root. When the current project has no memory, `recall_resume`
shows the most recently active other project and prints `_No memory for ...; showing ..._`.
That is a hint, not a fact about the current directory. Check the shown `@path` before editing.

## Zero-effort capture

Automate the handoff so a forgotten `recall_checkpoint` cannot lose a session:

```sh
recall autosave --watch              # background watcher, Ctrl+C to stop
recall autosave --once               # or run this from a scheduler
```

The importer reads `~/.jcode/sessions`, writes one checkpoint per session (later journal appends
update that checkpoint), imports explicit user preferences only, ignores `reasoning` blocks and
redacts secrets before writing. By default it keeps the current project (from the session's
`working_dir`) and files modified in the last 7 days; `--all` covers every project and
`--since DAYS` changes the window. Imported content is marked `unverified`: confirm files and
tests before acting. The agent should still call `recall_checkpoint` for decisions it made
in-context, because local reasoning never reaches the transcript.

On Windows, opt into a per-user Scheduled Task instead of starting a watcher by hand:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -Autosave
```

It runs `autosave --once --since 7` at logon and every 15 minutes with no admin rights. Stop it
with `-RemoveAutosave`; remove the shim and task with `scripts\uninstall-windows.ps1 -DryRun`
first, then without `-DryRun`.

## Tool mapping

| Moment | MCP tool | CLI equivalent |
|---|---|---|
| Session start | `recall_resume` | `recall resume` or `recall hook session-start` |
| Before compaction | `recall_checkpoint` | `recall checkpoint` or `recall hook pre-compact` |
| Uncertain | `recall_search` | `recall search "<query>"` |
| New task | `recall_brief` | `recall brief "<task>"` |
| Important fact | `recall_remember` + `recall_pin` | `recall remember ...` + `recall pin <id>` |
| End of session | `recall_stats` (optional) | `recall stats` or `recall hook stop` |
| Zero-effort capture | `recall_import_session` (or background autosave) | `recall autosave --watch` / `--once` |

## Minimum viable usage

If only one thing is automated, automate the checkpoint. If two, automate resume as well. Those two
calls turn an amnesiac agent into one that can continue a task across compaction and new sessions.
Search, brief and stats are refinements.
