// CLI entry point and command dispatch.
// Every command writes to injected streams and returns an exit code, which
// makes the CLI straightforward to test without spawning a process.

import fs from 'node:fs';
import path from 'node:path';

import {
  VERSION,
  estimateTokens,
  flagOn,
  listFlag,
  oneLine,
  parseArgs,
  parsePositiveInt,
  readStdinSync,
  writeFileAtomic,
} from './util.js';
import { RecallError } from './records.js';
import {
  brief,
  checkpoint,
  createSession,
  doctor,
  exportRecords,
  forget,
  list,
  remember,
  resume,
  search,
  setPinned,
  stats,
} from './service.js';
import {
  renderBriefBlock,
  renderDoctorReport,
  renderExportJson,
  renderExportMarkdown,
  renderList,
  renderSearchBlock,
  renderStats,
} from './render.js';
import { normalizeHandoffObject, parseMessagesInput } from './checkpoint.js';
import { runMcp } from './mcp.js';

const HELP = `recall ${VERSION} - durable memory and context survival for coding agents

USAGE
  recall <command> [options] [args]

MEMORY
  remember <text>                Store a fact/decision/preference/...
      --kind K                   fact|decision|preference|task|artifact|handoff|snippet
      --tag T                    add a tag (repeatable)
      --file F                   attach a file path (repeatable)
      --importance 1-5           default 3
      --supersedes <id>          mark an older record as contradicted
      --stdin                    read the text from stdin
      --global                   write to global.jsonl instead of the project file
      --session S --source S     provenance fields
      --force                    store even if text looks like a secret
  search "<query>"               BM25 search over text, tags and files
      --project X --kind K --tag T --file F
      --all                      search every project (default: current project only)
      --limit N                  default 10
      --budget TOKENS            default 800 (~4 chars/token)
      --literal                  substring search instead of BM25
      --json                     machine-readable output
  brief "<task>"                 ready-to-paste <recall-context> block
      --budget N                 default 1500
      --all                      rank memories from every project
  pin <id> | unpin <id>          keeps a record at the top of every briefing
  forget <id>                    append a delete tombstone
  list                           list records (newest first)
      --project X --all --kind K --tag T --file F --pinned --limit N --budget N
  stats                          store statistics and file diagnostics
  export --format md|json        export records (stdout, or --out FILE)

CONTEXT SURVIVAL
  checkpoint                     save a structured session handoff
      --goal TEXT
      --constraint TEXT          repeatable
      --decision TEXT            repeatable
      --file PATH                repeatable
      --command CMD              repeatable; use --test for test commands
      --open-question TEXT       repeatable
      --next TEXT                repeatable
      --blocker TEXT             repeatable
      --summary TEXT | --summary-file PATH
      --messages PATH            transcript JSON or JSONL to mine (or pipe on stdin)
      --data JSON                handoff object (snake_case or camelCase)
      --json
  resume                         one briefing: pinned, latest checkpoint, decisions
      --project X --budget N     default budget 1200
      --all

AGENT INTEGRATION
  mcp                            MCP 2024-11-05 server over stdio (newline JSON-RPC)
  hook session-start             print the resume briefing (for SessionStart hooks)
  hook pre-compact               save a checkpoint from stdin/transcript, print ack
  hook stop                      no-op, exit 0

MAINTENANCE
  doctor                         validate install, home, files and dependencies
  version                        print the version
  help                           this text

ENVIRONMENT
  RECALL_HOME      data directory (default ~/.jcode/recall)
  RECALL_PROJECT   default project name (default: basename of cwd)
  RECALL_SESSION   session id stored on new records

PROJECT IDENTITY
  Each project is keyed by its canonical git root (or absolute cwd when there
  is no git repository). The display name is only a label: two unrelated repos
  both named "app" never share a file. --project <name> matches labels across
  projects and prints each record's @path so provenance stays visible.

EXAMPLES
  recall remember "Use SQLite WAL mode for the queue" --kind decision --tag db --importance 4
  recall search "queue durability" --budget 400
  recall brief "add retry logic to the worker"
  node bin/recall.js checkpoint --goal "ship auth" --decision "use argon2" --next "write tests"
  node bin/recall.js resume --budget 900
  echo '{"goal":"fix login"}' | node bin/recall.js checkpoint --stdin

Data is append-only JSONL. Nothing leaves this machine.`;

function recordJson(record, score) {
  return {
    id: record.id,
    ts: record.ts,
    project: record.project,
    projectPath: record.projectPath || null,
    projectKey: record.projectKey || null,
    kind: record.kind,
    text: record.text,
    tags: record.tags,
    files: record.files,
    importance: record.importance,
    session: record.session,
    source: record.source,
    pinned: record.pinned,
    ...(record.supersededBy ? { supersededBy: record.supersededBy } : {}),
    ...(score === undefined ? {} : { score }),
  };
}

function readInputFile(cwd, file) {
  const target = path.resolve(cwd, file);
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    throw new RecallError(`cannot read file: ${file}`, 'EFILE');
  }
  if (stat.isDirectory()) throw new RecallError(`expected a file but found a directory: ${file}`, 'EFILE');
  if (stat.size > 25 * 1024 * 1024) throw new RecallError(`file is too large to read: ${file}`, 'EFILE');
  try {
    return fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '');
  } catch (error) {
    throw new RecallError(`cannot read file: ${file} (${error && error.message})`, 'EFILE');
  }
}

function stringFlag(flags, name) {
  const value = flags[name];
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'string' && item.trim());
    return first ? first : '';
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function collectExplicit(flags, cwd) {
  const explicit = {
    goal: stringFlag(flags, 'goal'),
    summary: stringFlag(flags, 'summary'),
    constraints: listFlag(flags, 'constraint'),
    decisions: listFlag(flags, 'decision'),
    files: listFlag(flags, 'file'),
    commands: [...listFlag(flags, 'command'), ...listFlag(flags, 'test')],
    openQuestions: listFlag(flags, 'open-question'),
    nextSteps: listFlag(flags, 'next'),
    blockers: listFlag(flags, 'blocker'),
  };

  if (flags.data) {
    const inline = typeof flags.data === 'string' ? flags.data.trim() : '';
    const raw = inline.startsWith('{') ? inline : readInputFile(cwd, inline);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new RecallError(`--data must be valid JSON (${error.message})`, 'EJSON');
    }
    const fromJson = normalizeHandoffObject(parsed);
    for (const key of ['constraints', 'decisions', 'files', 'commands', 'openQuestions', 'nextSteps', 'blockers']) {
      if (fromJson[key] && fromJson[key].length) explicit[key] = [...explicit[key], ...fromJson[key]];
    }
    if (!explicit.goal && fromJson.goal) explicit.goal = fromJson.goal;
    if (!explicit.summary && fromJson.summary) explicit.summary = fromJson.summary;
  }

  return explicit;
}

function collectCheckpointRaw(flags, cwd, stdinText) {
  let raw = '';
  let sourceLabel = 'stdin';

  if (flags.messages) {
    raw = readInputFile(cwd, flags.messages);
    sourceLabel = flags.messages;
  } else if (flags.transcript) {
    raw = readInputFile(cwd, flags.transcript);
    sourceLabel = flags.transcript;
  } else {
    raw = stdinText || '';
  }

  // Claude Code style hook payload: {"transcript_path": "...", ...}
  if (raw.trim()) {
    const parsed = parseMessagesInput(raw);
    if (!parsed.messages.length && parsed.transcriptPath) {
      raw = readInputFile(cwd, parsed.transcriptPath);
      sourceLabel = parsed.transcriptPath;
    }
  }

  return { raw, sourceLabel };
}

function summarizeCheckpointAck(result) {
  const bits = [];
  if (result.data.goal) bits.push(`goal: ${oneLine(result.data.goal)}`);
  bits.push(`${result.stats.messages || 0} msgs`);
  bits.push(`${result.stats.toolCalls || 0} tool calls`);
  const counts = [
    ['decisions', result.data.decisions.length],
    ['files', result.data.files.length],
    ['commands', result.data.commands.length],
    ['next', result.data.nextSteps.length],
  ].filter(([, n]) => n > 0).map(([name, n]) => `${n} ${name}`);
  const detail = counts.length ? `; ${counts.join(', ')}` : '';
  return `checkpoint ${result.record.id} saved (${bits.join(', ')}${detail})`;
}

async function runHook(kind, flags, context) {
  const { session, cwd, stdin, out, err } = context;

  if (kind === 'stop' || kind === 'session-end') {
    return 0;
  }

  if (kind === 'session-start') {
    const result = resume(session, {
      project: stringFlag(flags, 'project') || undefined,
      budget: parsePositiveInt(flags.budget, 900),
      all: flagOn(flags, 'all'),
    });
    out(result.text);
    return 0;
  }

  if (kind === 'pre-compact') {
    try {
      const stdinText = stdin();
      const { raw } = collectCheckpointRaw(flags, cwd, stdinText);
      if (!raw.trim()) {
        err('recall: no transcript on stdin; checkpoint skipped\n');
        return 0;
      }
      const explicit = collectExplicit(flags, cwd);
      const summary = flags['summary-file']
        ? readInputFile(cwd, flags['summary-file']).trim()
        : explicit.summary;
      const result = checkpoint(session, {
        raw,
        explicit,
        summary,
        project: stringFlag(flags, 'project') || undefined,
        session: stringFlag(flags, 'session') || undefined,
        source: 'hook',
      });
      out(`recall: ${summarizeCheckpointAck(result)}\n`);
      return 0;
    } catch (error) {
      // Hooks must never break the agent loop.
      err(`recall: checkpoint failed: ${error && error.message ? error.message : error}\n`);
      return 0;
    }
  }

  err(`recall: unknown hook "${kind}" (expected session-start, pre-compact, stop)\n`);
  return 2;
}

/**
 * Run the CLI.
 * @param {string[]} argv
 * @param {{env?: object, cwd?: string, now?: Date|string|number, stdinText?: string,
 *          stdout?: (s: string) => void, stderr?: (s: string) => void}} options
 * @returns {Promise<number>} exit code
 */
export async function main(argv, options = {}) {
  const { positionals, flags } = parseArgs(argv);
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const out = options.stdout || ((text) => process.stdout.write(text));
  const err = options.stderr || ((text) => process.stderr.write(text));

  let cachedStdin;
  const stdin = () => {
    if (cachedStdin === undefined) {
      cachedStdin = options.stdinText !== undefined ? String(options.stdinText) : readStdinSync();
    }
    return cachedStdin;
  };

  const command = (positionals[0] || '').toLowerCase();
  const args = positionals.slice(1);
  const session = createSession({ env, cwd, now: options.now });

  if (flagOn(flags, 'version') || command === 'version') {
    out(`${VERSION}\n`);
    return 0;
  }
  if (flagOn(flags, 'help') || !command || command === 'help') {
    out(`${HELP}\n`);
    return 0;
  }

  const context = { session, cwd, env, stdin, out, err };

  try {
    switch (command) {
      case 'remember': {
        const inputFromArgs = args.join(' ').trim();
        // Never touch stdin unless the caller asked for it: an agent or a CI
        // runner can leave stdin as an open pipe with no data, and a
        // speculative read would hang the command forever.
        const text = inputFromArgs || (flagOn(flags, 'stdin') ? stdin().trim() : '');
        if (!text) throw new RecallError('nothing to remember: pass text or pipe it with --stdin', 'ETEXT');

        const result = remember(session, {
          text,
          kind: stringFlag(flags, 'kind') || undefined,
          tags: listFlag(flags, 'tag'),
          files: listFlag(flags, 'file'),
          importance: flags.importance === undefined ? undefined : flags.importance,
          project: stringFlag(flags, 'project') || undefined,
          session: stringFlag(flags, 'session') || undefined,
          source: stringFlag(flags, 'source') || 'cli',
          supersedes: stringFlag(flags, 'supersedes') || undefined,
          global: flagOn(flags, 'global'),
          force: flagOn(flags, 'force'),
        });

        for (const warning of result.warnings) err(`recall: warning: ${warning}\n`);

        if (flagOn(flags, 'json')) {
          out(`${JSON.stringify({ ...recordJson(result.record), deduped: result.deduped, superseded: result.superseded }, null, 2)}\n`);
        } else if (result.deduped) {
          out(`duplicate ${result.record.id} (${result.record.kind}, imp${result.record.importance}) in ${result.project}${result.merged ? ' (tags/files merged)' : ' (no change)'}\n`);
        } else {
          out(`remembered ${result.record.id} (${result.record.kind}, imp${result.record.importance}) in ${result.project}\n`);
        }
        return 0;
      }

      case 'search': {
        const query = args.join(' ').trim();
        if (!query) throw new RecallError('usage: recall search "<query>"', 'EQUERY');
        const budget = parsePositiveInt(flags.budget, 800);
        const result = search(session, {
          query,
          project: stringFlag(flags, 'project') || undefined,
          kind: stringFlag(flags, 'kind') || undefined,
          tag: stringFlag(flags, 'tag') || undefined,
          file: stringFlag(flags, 'file') || undefined,
          limit: flags.limit === undefined ? undefined : flags.limit,
          literal: flagOn(flags, 'literal'),
          includeSuperseded: flagOn(flags, 'include-superseded'),
          pinnedOnly: flagOn(flags, 'pinned'),
          all: flagOn(flags, 'all'),
        });

        if (flagOn(flags, 'json')) {
          out(`${JSON.stringify({
            query,
            project: result.project,
            total: result.total,
            returned: result.hits.length,
            budget,
            hits: result.hits.map((hit) => recordJson(hit.record, hit.score)),
          }, null, 2)}\n`);
        } else {
          out(renderSearchBlock({
            query,
            hits: result.hits,
            total: result.total,
            budget,
            project: stringFlag(flags, 'project') || null,
            showPaths: result.showPaths,
            showProject: true,
          }));
        }
        return 0;
      }

      case 'brief': {
        const task = args.join(' ').trim() || (flagOn(flags, 'stdin') ? stdin().trim() : '');
        if (!task) throw new RecallError('usage: recall brief "<task description>"', 'EQUERY');
        const budget = parsePositiveInt(flags.budget, 1500);
        const result = brief(session, {
          task,
          project: stringFlag(flags, 'project') || undefined,
          budget,
          limit: flags.limit === undefined ? undefined : flags.limit,
          all: flagOn(flags, 'all'),
        });

        if (flagOn(flags, 'json')) {
          out(`${JSON.stringify({
            task,
            project: result.project,
            total: result.total,
            returned: result.hits.length,
            budget,
            approxTokens: estimateTokens(renderBriefBlock({
              task, hits: result.hits, total: result.total, budget,
              project: result.project === 'all' ? null : result.project,
            })),
            hits: result.hits.map((hit) => recordJson(hit.record, hit.score)),
          }, null, 2)}\n`);
        } else {
          out(renderBriefBlock({
            task,
            hits: result.hits,
            total: result.total,
            budget,
            project: result.project === 'all' ? null : result.project,
            now: session.now,
            showProject: true,
            showPaths: result.showPaths,
          }));
        }
        return 0;
      }

      case 'checkpoint': {
        // A handoff from flags needs no stdin. Only read it when the caller
        // pipes a transcript, or when nothing else was supplied (the
        // `hook pre-compact` shape).
        const structured = [
          'goal', 'constraint', 'decision', 'file', 'command', 'test',
          'open-question', 'next', 'blocker', 'artifact', 'summary',
          'summary-file', 'messages', 'data',
        ].some((name) => flags[name] !== undefined);
        const stdinText = flagOn(flags, 'stdin') || !structured ? stdin() : '';
        const { raw } = collectCheckpointRaw(flags, cwd, stdinText);
        const explicit = collectExplicit(flags, cwd);
        const summary = flags['summary-file']
          ? readInputFile(cwd, flags['summary-file']).trim()
          : explicit.summary;

        const result = checkpoint(session, {
          raw,
          explicit,
          summary,
          project: stringFlag(flags, 'project') || undefined,
          session: stringFlag(flags, 'session') || undefined,
          source: stringFlag(flags, 'source') || 'cli',
          importance: flags.importance === undefined ? undefined : flags.importance,
          tags: listFlag(flags, 'tag'),
          global: flagOn(flags, 'global'),
        });

        if (flagOn(flags, 'json')) {
          out(`${JSON.stringify({
            id: result.record.id,
            ts: result.record.ts,
            project: result.project,
            stats: result.stats,
            data: result.data,
          }, null, 2)}\n`);
        } else {
          out(`${summarizeCheckpointAck(result)}\n`);
          out(`run \`recall resume\` to see what the next agent will receive\n`);
        }
        return 0;
      }

      case 'resume': {
        const budget = parsePositiveInt(flags.budget, 1200);
        const result = resume(session, {
          project: stringFlag(flags, 'project') || undefined,
          budget,
          all: flagOn(flags, 'all'),
        });
        if (flagOn(flags, 'json')) {
          out(`${JSON.stringify({
            project: result.project,
            budget,
            approxTokens: estimateTokens(result.text),
            count: result.records.length,
            text: result.text,
          }, null, 2)}\n`);
        } else {
          out(result.text);
        }
        return 0;
      }

      case 'pin':
      case 'unpin': {
        const ids = args.filter(Boolean);
        if (!ids.length) throw new RecallError(`usage: recall ${command} <id> [id...]`, 'EID');
        const pinned = command === 'pin';
        const results = ids.map((id) => setPinned(session, id, pinned));
        if (flagOn(flags, 'json')) {
          out(`${JSON.stringify(results.map((item) => recordJson(item.record)), null, 2)}\n`);
        } else {
          for (const item of results) out(`${pinned ? 'pinned' : 'unpinned'} ${item.record.id}\n`);
        }
        return 0;
      }

      case 'forget': {
        const ids = args.filter(Boolean);
        if (!ids.length) throw new RecallError('usage: recall forget <id> [id...]', 'EID');
        const results = ids.map((id) => forget(session, id));
        if (flagOn(flags, 'json')) {
          out(`${JSON.stringify({ forgotten: results.map((item) => item.record.id) }, null, 2)}\n`);
        } else {
          for (const item of results) out(`forgot ${item.record.id} (${item.record.kind})\n`);
        }
        return 0;
      }

      case 'list': {
        const budget = parsePositiveInt(flags.budget, 4000);
        const result = list(session, {
          project: stringFlag(flags, 'project') || undefined,
          all: flagOn(flags, 'all'),
          kind: stringFlag(flags, 'kind') || undefined,
          tag: stringFlag(flags, 'tag') || undefined,
          file: stringFlag(flags, 'file') || undefined,
          pinned: flagOn(flags, 'pinned'),
          limit: flags.limit === undefined ? 50 : flags.limit,
          includeSuperseded: flagOn(flags, 'include-superseded'),
        });
        if (flagOn(flags, 'json')) {
          out(`${JSON.stringify({
            project: result.project,
            total: result.total,
            returned: result.records.length,
            records: result.records.map((record) => recordJson(record)),
          }, null, 2)}\n`);
        } else {
          out(renderList(result.records, {
            budget,
            project: result.project === 'all' ? null : result.project,
            showPaths: result.showPaths,
          }));
        }
        return 0;
      }

      case 'stats': {
        const result = stats(session, { project: stringFlag(flags, 'project') || undefined });
        if (flagOn(flags, 'json')) {
          out(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          out(renderStats(result.summary, result.diagnostics));
        }
        return 0;
      }

      case 'export': {
        const format = (stringFlag(flags, 'format') || 'md').toLowerCase();
        if (!['md', 'markdown', 'json'].includes(format)) {
          throw new RecallError('usage: recall export --format md|json [--out FILE]', 'EFORMAT');
        }
        const result = exportRecords(session, {
          project: stringFlag(flags, 'project') || undefined,
          kind: stringFlag(flags, 'kind') || undefined,
          includeSuperseded: flagOn(flags, 'include-superseded'),
        });
        const content = format === 'json'
          ? renderExportJson(result.records, { project: result.project, home: result.home })
          : renderExportMarkdown(result.records, { project: result.project });

        const outFile = stringFlag(flags, 'out');
        if (outFile) {
          const target = path.resolve(cwd, outFile);
          writeFileAtomic(target, content);
          out(`exported ${result.records.length} record(s) to ${target}\n`);
        } else {
          out(content);
        }
        return 0;
      }

      case 'doctor': {
        const result = doctor(session);
        if (flagOn(flags, 'json')) {
          out(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          out(renderDoctorReport(result));
        }
        return result.ok ? 0 : 1;
      }

      case 'hook': {
        const kind = (args[0] || '').toLowerCase();
        if (!kind) throw new RecallError('usage: recall hook <session-start|pre-compact|stop>', 'EHOOK');
        return await runHook(kind, flags, context);
      }

      case 'mcp': {
        return await runMcp({ env, cwd });
      }

      default:
        err(`recall: unknown command "${command}"\n\n`);
        out(`${HELP}\n`);
        return 2;
    }
  } catch (error) {
    if (error instanceof RecallError) {
      err(`recall: ${error.message}\n`);
      return 2;
    }
    err(`recall: internal error: ${error && error.stack ? error.stack : error}\n`);
    return 1;
  }
}

export { HELP };
export default main;
