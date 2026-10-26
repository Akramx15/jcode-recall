// Minimal MCP 2024-11-05 server over stdio.
//
// Framing: newline-delimited JSON-RPC 2.0. Reads are buffered, so a message may
// arrive split across any number of chunks (or several per chunk). Nothing is
// ever written to stdout except JSON-RPC responses; logs go to stderr.

import { VERSION, PROTOCOL_VERSION } from './util.js';
import {
  brief,
  checkpoint,
  createSession,
  forget,
  remember,
  resume,
  search,
  setPinned,
  stats,
} from './service.js';
import { RecallError } from './records.js';
import {
  renderBriefBlock,
  renderSearchBlock,
  renderStats,
} from './render.js';
import { normalizeHandoffObject } from './checkpoint.js';
import { formatImportSummary, importSessionsSync } from './import.js';
import { oneLine, truncateChars } from './util.js';

const INSTRUCTIONS = [
  'jcode-recall is a local, deterministic memory store.',
  'On session start call recall_resume to load pinned facts and the latest checkpoint.',
  'Before context compaction call recall_checkpoint with a goal, decisions and next steps.',
  'When unsure about a past decision call recall_search instead of guessing.',
  'If resume shows another project, verify the path before acting.',
  'Run `recall autosave --watch` (or a scheduled `recall autosave --once`) so compaction cannot lose a session.',
  'Never store secrets, tokens or credentials.',
  'Keep entries short and include the rationale for decisions.',
].join('\n');

const TOOLS = [
  {
    name: 'recall_remember',
    description: 'Store a durable memory (fact, decision, preference, task, artifact, handoff or snippet). Identical text in the same project is deduplicated.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The memory text. Short and specific.' },
        kind: { type: 'string', enum: ['fact', 'decision', 'preference', 'task', 'artifact', 'handoff', 'snippet'], default: 'fact' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for retrieval.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Related file paths.' },
        importance: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
        project: { type: 'string', description: 'Project name. Defaults to the current directory name.' },
        session: { type: 'string', description: 'Optional session identifier.' },
        supersedes: { type: 'string', description: 'Id of a record this one contradicts or replaces.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'recall_search',
    description: 'Search memories with BM25 (Arabic/Latin/CJK aware) plus recency, importance, project and pin boosts. Returns a compact Markdown block within a token budget.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        project: { type: 'string' },
        kind: { type: 'string' },
        tag: { type: 'string' },
        file: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 8 },
        budget: { type: 'integer', minimum: 50, maximum: 20000, default: 800 },
        literal: { type: 'boolean', description: 'Substring mode instead of BM25.' },
        all: { type: 'boolean', description: 'Search every project instead of only the current one.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'recall_brief',
    description: 'Rank memories for a task and return a ready-to-paste <recall-context> block with provenance, inside a token budget.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        project: { type: 'string' },
        budget: { type: 'integer', minimum: 100, maximum: 20000, default: 1500 },
        all: { type: 'boolean' },
      },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'recall_checkpoint',
    description: 'Save a structured session handoff before context compaction. Fields can be supplied directly; `messages` (transcript JSON/JSONL) is mined deterministically for additional facts.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        summary: { type: 'string' },
        constraints: { type: 'array', items: { type: 'string' } },
        decisions: { type: 'array', items: { type: 'string' } },
        files_touched: { type: 'array', items: { type: 'string' } },
        commands: { type: 'array', items: { type: 'string' }, description: 'Commands or tests run, optionally with results.' },
        open_questions: { type: 'array', items: { type: 'string' } },
        next_steps: { type: 'array', items: { type: 'string' } },
        blockers: { type: 'array', items: { type: 'string' } },
        messages: { type: ['string', 'array'], description: 'Transcript text or array of message objects.' },
        project: { type: 'string' },
        session: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'recall_resume',
    description: 'Return a single briefing for a compacted or fresh context: pinned facts, latest checkpoint (unverified/stale marked), decisions, preferences, artifacts and open tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        budget: { type: 'integer', minimum: 100, maximum: 20000, default: 1200 },
        all: { type: 'boolean', description: 'Include every project.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'recall_pin',
    description: 'Pin or unpin a record so it is always included in resume briefings.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        pinned: { type: 'boolean', default: true },
      },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'recall_forget',
    description: 'Delete a record by id (append-only tombstone, recoverable from the JSONL history).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'recall_stats',
    description: 'Show store statistics: counts by kind/project, pinned records, file diagnostics and malformed-line counts.',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'recall_import_session',
    description: 'Import a Jcode session snapshot, journal or sessions directory into memory. Idempotent: repeats do not duplicate records. Imported content is unverified. One checkpoint per session, at most 40 preferences.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Session .json, .journal.jsonl, or directory.' },
        dir: { type: 'string', description: 'Sessions directory (default: ~/.jcode/sessions).' },
        project: { type: 'string', description: 'Attribute all imported records to this project (path or name).' },
        all: { type: 'boolean', description: 'Import every project instead of only the current one.' },
        since: { type: 'number', description: 'Only files modified in the last N days (0 = no limit).' },
      },
      additionalProperties: false,
    },
  },
];

function asString(value, field, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new RecallError(`${field} is required`, 'EARGS');
    return '';
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new RecallError(`${field} must be a string`, 'EARGS');
}

function asStringArray(value, field) {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === 'string').map((item) => item).slice(0, 100);
  }
  if (typeof value === 'string') return [value];
  throw new RecallError(`${field} must be an array of strings`, 'EARGS');
}

function asInt(value, fallback, field) {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) throw new RecallError(`${field} must be an integer`, 'EARGS');
  return Math.trunc(n);
}

function asBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).toLowerCase();
  return s === 'true' || s === '1' || s === 'yes';
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

function summarizeRecord(record, prefix) {
  const tags = record.tags && record.tags.length ? ` · tags: ${record.tags.join(', ')}` : '';
  const files = record.files && record.files.length ? ` · files: ${record.files.slice(0, 5).join(', ')}` : '';
  return `${prefix} ${record.id} (${record.kind}, imp${record.importance}, project ${record.project})${tags}${files}\n${truncateChars(oneLine(record.text), 400)}`;
}

function callTool(name, args, session) {
  switch (name) {
    case 'recall_remember': {
      const result = remember(session, {
        text: asString(args.text, 'text', { required: true }),
        kind: asString(args.kind, 'kind') || undefined,
        tags: asStringArray(args.tags, 'tags'),
        files: asStringArray(args.files, 'files'),
        importance: args.importance === undefined ? undefined : asInt(args.importance, 3, 'importance'),
        project: asString(args.project, 'project') || undefined,
        session: asString(args.session, 'session') || undefined,
        supersedes: asString(args.supersedes, 'supersedes') || undefined,
        source: 'mcp',
        force: false,
      });
      const prefix = result.deduped ? 'duplicate (no new record):' : 'remembered';
      const lines = [summarizeRecord(result.record, prefix)];
      if (result.superseded) lines.push(`superseded ${result.superseded}`);
      for (const warning of result.warnings) lines.push(`warning: ${warning}`);
      return textResult(lines.join('\n'));
    }

    case 'recall_search': {
      const query = asString(args.query, 'query', { required: true });
      const budget = asInt(args.budget, 800, 'budget');
      const result = search(session, {
        query,
        project: asString(args.project, 'project') || undefined,
        kind: asString(args.kind, 'kind') || undefined,
        tag: asString(args.tag, 'tag') || undefined,
        file: asString(args.file, 'file') || undefined,
        limit: asInt(args.limit, 8, 'limit'),
        literal: asBool(args.literal),
        all: asBool(args.all),
      });
      const text = renderSearchBlock({
        query,
        hits: result.hits,
        total: result.total,
        budget,
        project: args.project || null,
        showPaths: Boolean(args.project),
        showProject: true,
      });
      return textResult(text || '_No memory matched._');
    }

    case 'recall_brief': {
      const task = asString(args.task, 'task', { required: true });
      const budget = asInt(args.budget, 1500, 'budget');
      const result = brief(session, {
        task,
        project: asString(args.project, 'project') || undefined,
        budget,
        all: asBool(args.all),
      });
      return textResult(renderBriefBlock({
        task,
        hits: result.hits,
        total: result.total,
        budget,
        project: result.project === 'all' ? null : result.project,
        showProject: true,
        showPaths: Boolean(args.project),
      }));
    }

    case 'recall_checkpoint': {
      const explicit = normalizeHandoffObject(args);
      let raw = '';
      if (typeof args.messages === 'string') raw = args.messages;
      else if (Array.isArray(args.messages)) {
        try {
          raw = JSON.stringify(args.messages);
        } catch {
          raw = '';
        }
      }
      const result = checkpoint(session, {
        raw,
        explicit,
        project: asString(args.project, 'project') || undefined,
        session: asString(args.session, 'session') || undefined,
        summary: asString(args.summary, 'summary') || '',
        source: 'mcp',
      });
      return textResult([
        `checkpoint ${result.record.id} saved (project ${result.project})`,
        `observed: ${result.stats.messages} messages, ${result.stats.toolCalls} tool calls`,
        result.record.text,
      ].join('\n'));
    }

    case 'recall_resume': {
      const result = resume(session, {
        project: asString(args.project, 'project') || undefined,
        budget: asInt(args.budget, 1200, 'budget'),
        all: asBool(args.all),
      });
      return textResult(result.text);
    }

    case 'recall_pin': {
      const id = asString(args.id, 'id', { required: true });
      const pinned = asBool(args.pinned, true);
      const result = setPinned(session, id, pinned);
      return textResult(`${pinned ? 'pinned' : 'unpinned'} ${result.record.id} (${result.record.kind})`);
    }

    case 'recall_forget': {
      const id = asString(args.id, 'id', { required: true });
      const result = forget(session, id);
      return textResult(`forgot ${result.record.id} (${result.record.kind})`);
    }

    case 'recall_stats': {
      const result = stats(session, { project: asString(args.project, 'project') || undefined });
      return textResult(renderStats(result.summary, result.diagnostics));
    }

    case 'recall_import_session': {
      const pathArg = asString(args.path, 'path') || undefined;
      const dirArg = asString(args.dir, 'dir') || undefined;
      const result = importSessionsSync(session, {
        path: pathArg,
        dir: dirArg,
        project: asString(args.project, 'project') || undefined,
        all: asBool(args.all),
        sinceDays: args.since === undefined ? undefined : asInt(args.since, 0, 'since'),
        scope: !pathArg && !dirArg ? 'project' : undefined,
      });
      const lines = [formatImportSummary(result)];
      if (result.errors && result.errors.length) {
        lines.push(...result.errors.slice(0, 5).map((error) => `warning: ${error}`));
      }
      lines.push('Imported session content is unverified; confirm files and tests before acting on it.');
      return textResult(lines.join('\n'));
    }

    default:
      throw new RecallError(`unknown tool "${name}"`, 'ENOTOOL');
  }
}

function makeError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id === undefined ? null : id, error };
}

function makeResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function validateMessage(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
  if (msg.jsonrpc !== undefined && msg.jsonrpc !== '2.0') return false;
  if (typeof msg.method !== 'string') return false;
  return true;
}

/**
 * Handle one JSON-RPC message. Returns a response object, or null for
 * notifications (no id). Never throws.
 */
export function handleMessage(msg, session) {
  if (!validateMessage(msg)) {
    return makeError(msg && msg.id, -32600, 'Invalid Request');
  }

  const isNotification = msg.id === undefined || msg.id === null;
  const { method } = msg;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};

  const respond = (result) => (isNotification ? null : makeResult(msg.id, result));
  const fail = (code, message) => (isNotification ? null : makeError(msg.id, code, message));

  try {
    switch (method) {
      case 'initialize':
        return respond({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'jcode-recall', version: VERSION },
          instructions: INSTRUCTIONS,
        });

      case 'notifications/initialized':
      case 'notifications/cancelled':
      case 'initialized':
        return null;

      case 'ping':
        return respond({});

      case 'tools/list':
        return respond({ tools: TOOLS });

      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        if (!name) return fail(-32602, 'tools/call requires params.name');
        const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? params.arguments
          : {};
        try {
          return respond(callTool(name, args, session));
        } catch (error) {
          if (error instanceof RecallError) {
            return respond(textResult(`error: ${error.message}`, true));
          }
          throw error;
        }
      }

      default:
        return fail(-32601, `Method not found: ${method}`);
    }
  } catch (error) {
    return fail(-32603, error && error.message ? error.message : 'Internal error');
  }
}

function processLine(line, session, write) {
  const trimmed = line.replace(/\r$/, '').trim();
  if (!trimmed) return;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    write(makeError(null, -32700, 'Parse error', error && error.message ? error.message : undefined));
    return;
  }

  if (Array.isArray(parsed)) {
    if (!parsed.length) {
      write(makeError(null, -32600, 'Invalid Request'));
      return;
    }
    const responses = parsed.map((item) => handleMessage(item, session)).filter(Boolean);
    if (responses.length) write(responses);
    return;
  }

  const response = handleMessage(parsed, session);
  if (response) write(response);
}

/**
 * Run the MCP server until stdin closes.
 * @param {{stdin?: NodeJS.ReadableStream, stdout?: NodeJS.WritableStream, stderr?: NodeJS.WritableStream, env?: object, cwd?: string}} options
 */
export function runMcp(options = {}) {
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const session = createSession({ env: options.env || process.env, cwd: options.cwd || process.cwd() });

  const write = (payload) => {
    try {
      stdout.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      if (stderr && stderr.write) stderr.write(`recall mcp: write failed: ${error && error.message}\n`);
    }
  };

  return new Promise((resolve) => {
    let buffer = '';
    let queue = Promise.resolve();
    let closed = false;

    const finish = (code = 0) => {
      if (closed) return;
      closed = true;
      resolve(code);
    };

    stdin.setEncoding && stdin.setEncoding('utf8');

    stdin.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        queue = queue.then(() => processLine(line, session, write)).catch((error) => {
          if (stderr && stderr.write) stderr.write(`recall mcp: handler error: ${error && error.message}\n`);
        });
        index = buffer.indexOf('\n');
      }
    });

    stdin.on('end', () => {
      queue = queue.then(() => {
        if (buffer.trim()) processLine(buffer, session, write);
      }).catch((error) => {
        if (stderr && stderr.write) stderr.write(`recall mcp: final line error: ${error && error.message}\n`);
      }).finally(() => finish(0));
    });

    stdin.on('error', (error) => {
      if (stderr && stderr.write) stderr.write(`recall mcp: stdin error: ${error && error.message}\n`);
      queue.finally(() => finish(1));
    });

    stdin.resume && stdin.resume();
  });
}

export const MCP_TOOLS = TOOLS;
export const MCP_INSTRUCTIONS = INSTRUCTIONS;
