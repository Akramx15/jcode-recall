// Core operations shared by the CLI and the MCP server.
// Every function is deterministic apart from the clock, and never calls the
// network. Errors are thrown as RecallError with a stable code.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deleteRecord,
  fileDiagnostics,
  findRecordById,
  insertRecord,
  loadAllRecords,
  projectSelector,
  recordKey,
  recordMatches,
  resolveContext,
  resolveHome,
  summarize,
  updateRecord,
} from './store.js';
import { buildRecord, deepRedact, detectSecrets, RecallError } from './records.js';
import {
  checkpointText,
  extractHandoff,
  hasSignal,
  mergeHandoff,
} from './checkpoint.js';
import { limitResults, rankRecords, visibleRecords } from './rank.js';
import { renderResume } from './render.js';
import { ensureDir, parsePositiveInt } from './util.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createSession(options = {}) {
  return {
    env: options.env || process.env,
    cwd: options.cwd || process.cwd(),
    now: options.now ? new Date(options.now) : new Date(),
  };
}

export function homeFor(session) {
  return resolveHome(session.env);
}

function contextFor(session, flags = {}) {
  return resolveContext(flags, { env: session.env, cwd: session.cwd });
}

/** Store one memory. Refuses likely secrets unless `force` is set. */
export function remember(session, options = {}) {
  const ctx = contextFor(session, options);
  const text = String(options.text ?? '').trim();
  if (!text) throw new RecallError('text is required (pass it as an argument or with --stdin)', 'ETEXT');

  if (!options.force) {
    const labels = detectSecrets(text);
    if (labels.length) {
      throw new RecallError(
        `refusing to store a likely secret (${labels.join(', ')}). Use --force only if this is intentional.`,
        'ESECRET',
      );
    }
  }

  const record = buildRecord({
    text,
    kind: options.kind,
    tags: options.tags,
    files: options.files,
    importance: options.importance,
    project: ctx.project,
    projectPath: ctx.projectPath,
    projectKey: ctx.projectKey,
    session: options.session || session.env.RECALL_SESSION || 'default',
    source: options.source || 'cli',
  }, { now: session.now });

  const result = insertRecord(ctx.file, record, { dedupe: options.dedupe !== false });

  let superseded = null;
  const warnings = [];
  if (options.supersedes) {
    const targetId = String(options.supersedes).trim();
    const found = findRecordById(ctx.home, targetId);
    if (!found) {
      warnings.push(`supersedes target "${targetId}" was not found; record saved anyway`);
    } else if (found.record.id === result.record.id) {
      warnings.push('supersedes target is the same record; nothing to supersede');
    } else {
      updateRecord(found.file, found.record.id, { supersededBy: result.record.id });
      superseded = found.record.id;
    }
  }

  return {
    record: result.record,
    deduped: result.deduped,
    merged: result.merged,
    superseded,
    warnings,
    project: ctx.project,
    file: ctx.file,
    home: ctx.home,
  };
}

export function search(session, options = {}) {
  const query = String(options.query ?? '').trim();
  if (!query) throw new RecallError('a search query is required', 'EQUERY');

  const ctx = contextFor(session, { project: options.project });
  const loaded = loadAllRecords(ctx.home);
  const limit = parsePositiveInt(options.limit, 10);
  const selector = options.all
    ? null
    : (options.project
      ? projectSelector(options.project, { cwd: session.cwd, env: session.env })
      : { key: ctx.projectKey });
  const hits = rankRecords(loaded.records, query, {
    kind: options.kind,
    tag: options.tag,
    file: options.file,
    selector,
    boostKey: ctx.projectKey,
    literal: Boolean(options.literal),
    includeSuperseded: Boolean(options.includeSuperseded),
    pinnedOnly: Boolean(options.pinnedOnly),
    now: session.now.getTime(),
  });

  return {
    query,
    hits: limitResults(hits, limit),
    total: hits.length,
    project: options.all ? 'all' : (options.project || ctx.project),
    showPaths: Boolean(options.project),
    selector,
    home: ctx.home,
    records: loaded.records,
  };
}

export function brief(session, options = {}) {
  const task = String(options.task ?? '').trim();
  if (!task) throw new RecallError('a task description is required', 'EQUERY');
  const result = search(session, {
    ...options,
    query: task,
    limit: parsePositiveInt(options.limit, 30),
  });
  return { ...result, task };
}

/**
 * Build and store a checkpoint.
 * `raw` is transcript text (JSON/JSONL/prose); `explicit` overrides extraction.
 */
export function checkpoint(session, options = {}) {
  const ctx = contextFor(session, options);
  const extracted = extractHandoff(options.raw || '', { project: ctx.project });
  let data = mergeHandoff(extracted.data, options.explicit || {});

  if (options.summary) data.summary = String(options.summary).trim().slice(0, 8000);
  if (!hasSignal(data)) {
    throw new RecallError('nothing to checkpoint (no goal, decisions, files, commands or summary found)', 'EEMPTY');
  }

  data = deepRedact(data);
  const stats = extracted.stats || { messages: 0, toolCalls: 0 };

  const text = checkpointText(data, { project: ctx.project, stats });
  const tags = ['checkpoint', ...(options.tags || [])];
  const record = buildRecord({
    text,
    kind: 'handoff',
    tags,
    files: data.files,
    importance: options.importance ?? 4,
    project: ctx.project,
    projectPath: ctx.projectPath,
    projectKey: ctx.projectKey,
    session: options.session || session.env.RECALL_SESSION || 'default',
    source: options.source || 'cli',
    data,
    task: data.goal,
  }, { now: session.now });

  const result = insertRecord(ctx.file, record, { dedupe: false });
  return {
    record: result.record,
    data,
    stats,
    project: ctx.project,
    file: ctx.file,
    home: ctx.home,
  };
}

export function resume(session, options = {}) {
  const ctx = contextFor(session, { project: options.project });
  const selector = options.project
    ? projectSelector(options.project, { cwd: session.cwd, env: session.env })
    : (options.all ? null : { key: ctx.projectKey });
  const loaded = loadAllRecords(ctx.home);
  const records = selector ? loaded.records.filter((record) => recordMatches(record, selector)) : loaded.records;
  const displayProject = options.all
    ? 'all'
    : (selector && selector.label ? selector.label : ctx.project);
  const showPaths = Boolean(options.project);

  return {
    text: renderResume({
      project: displayProject,
      projectPath: selector && selector.key === ctx.projectKey ? ctx.projectPath : null,
      records,
      budget: parsePositiveInt(options.budget, 1200),
      now: session.now.getTime(),
      home: ctx.home,
      showPaths,
      showProject: true,
      explicitProject: Boolean(options.project),
    }),
    records,
    project: displayProject,
    home: ctx.home,
  };
}

export function setPinned(session, id, pinned) {
  const target = String(id ?? '').trim();
  if (!target) throw new RecallError('a record id is required', 'EID');
  const found = findRecordById(homeFor(session), target);
  if (!found) throw new RecallError(`record "${target}" not found`, 'ENOTFOUND');
  const updated = updateRecord(found.file, found.record.id, { pinned: Boolean(pinned) });
  return { record: updated, file: found.file };
}

export function forget(session, id) {
  const target = String(id ?? '').trim();
  if (!target) throw new RecallError('a record id is required', 'EID');
  const found = findRecordById(homeFor(session), target);
  if (!found) throw new RecallError(`record "${target}" not found`, 'ENOTFOUND');
  deleteRecord(found.file, found.record.id);
  return { record: found.record, file: found.file };
}

/**
 * List records. `scope: 'project'` (default) or `'all'`.
 */
export function list(session, options = {}) {
  const ctx = contextFor(session, { project: options.project });
  const loaded = loadAllRecords(ctx.home);
  const selector = options.project
    ? projectSelector(options.project, { cwd: session.cwd, env: session.env })
    : (options.all ? null : { key: ctx.projectKey });
  let records = visibleRecords(loaded.records, { includeSuperseded: Boolean(options.includeSuperseded) });

  if (selector) records = records.filter((record) => recordMatches(record, selector));
  if (options.kind) records = records.filter((record) => record.kind === String(options.kind).toLowerCase());
  if (options.pinned) records = records.filter((record) => record.pinned);
  if (options.tag) {
    const want = String(options.tag).trim().toLowerCase();
    records = records.filter((record) => (record.tags || []).some((tag) => tag.toLowerCase() === want));
  }
  if (options.file) {
    const want = String(options.file).replace(/\\/g, '/').toLowerCase();
    records = records.filter((record) => (record.files || []).some((file) => file.toLowerCase().includes(want)));
  }

  records = records.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
  const limit = parsePositiveInt(options.limit, 0);
  const total = records.length;
  if (limit) records = records.slice(0, limit);

  const displayProject = options.all ? 'all' : (selector && selector.label ? selector.label : ctx.project);
  return {
    records,
    total,
    project: displayProject,
    showPaths: Boolean(options.project),
    home: ctx.home,
  };
}

export function stats(session, options = {}) {
  const ctx = contextFor(session, { project: options.project });
  const loaded = loadAllRecords(ctx.home);
  let records = loaded.records;
  const selector = options.project
    ? projectSelector(options.project, { cwd: session.cwd, env: session.env })
    : null;
  if (selector) records = records.filter((record) => recordMatches(record, selector));
  return {
    summary: summarize(records, ctx.home),
    diagnostics: fileDiagnostics(ctx.home),
    malformed: loaded.malformed,
    project: options.project || 'all',
  };
}

export function exportRecords(session, options = {}) {
  const ctx = contextFor(session, { project: options.project });
  const loaded = loadAllRecords(ctx.home);
  let records = loaded.records;
  const selector = options.project
    ? projectSelector(options.project, { cwd: session.cwd, env: session.env })
    : null;
  if (selector) records = records.filter((record) => recordMatches(record, selector));
  if (options.kind) records = records.filter((record) => record.kind === String(options.kind).toLowerCase());
  if (!options.includeSuperseded) records = records.filter((record) => !record.supersededBy);
  records = records.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
  return { records, project: options.project || null, home: ctx.home };
}

export function doctor(session) {
  const checks = [];
  const home = resolveHome(session.env);
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);

  checks.push({
    name: 'node version',
    ok: major >= 20,
    detail: `${process.version} (need >=20)`,
  });

  checks.push({
    name: 'RECALL_HOME',
    ok: path.isAbsolute(home),
    detail: home,
  });

  let writable = false;
  let writeError = '';
  try {
    ensureDir(home);
    const probe = path.join(home, `.doctor-${process.pid}-${Date.now().toString(36)}.tmp`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.rmSync(probe, { force: true });
    writable = true;
  } catch (error) {
    writeError = error && error.message ? error.message : String(error);
  }
  checks.push({ name: 'home writable', ok: writable, detail: writable ? 'yes' : writeError });

  const diagnostics = fileDiagnostics(home);
  const malformed = diagnostics.reduce((sum, item) => sum + item.malformed, 0);
  const truncated = diagnostics.filter((item) => item.truncatedTail).length;
  const totalRecords = diagnostics.reduce((sum, item) => sum + item.records, 0);

  checks.push({
    name: 'data files parse',
    ok: true,
    warn: malformed > 0,
    detail: `${diagnostics.length} file(s), ${totalRecords} record(s), ${malformed} malformed line(s) skipped`,
  });

  if (truncated > 0) {
    checks.push({
      name: 'unterminated last line',
      ok: true,
      warn: true,
      detail: `${truncated} file(s) did not end with a newline; those lines are still parsed if valid JSON`,
    });
  }

  let locks = [];
  try {
    locks = fs.readdirSync(home).filter((name) => name.endsWith('.lock'));
  } catch {
    locks = [];
  }
  checks.push({
    name: 'stale locks',
    ok: true,
    warn: locks.length > 0,
    detail: locks.length ? locks.join(', ') : 'none',
  });

  let dependencies = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    dependencies = Object.keys(pkg.dependencies || {});
  } catch {
    dependencies = null;
  }
  checks.push({
    name: 'runtime dependencies',
    ok: dependencies !== null && dependencies.length === 0,
    detail: dependencies === null ? 'package.json not readable' : (dependencies.length ? dependencies.join(', ') : 'none (zero-dependency)'),
  });

  const ok = checks.every((check) => check.ok);
  return { ok, checks, diagnostics, home };
}

/** Expand a record id prefix to a unique full id (convenience for humans). */
export function resolveId(session, prefixOrId) {
  const needle = String(prefixOrId ?? '').trim();
  if (!needle) throw new RecallError('a record id is required', 'EID');
  const direct = findRecordById(homeFor(session), needle);
  if (direct) return direct;
  const loaded = loadAllRecords(homeFor(session));
  const matches = loaded.records.filter((record) => record.id.startsWith(needle));
  if (matches.length === 1) {
    const found = findRecordById(homeFor(session), matches[0].id);
    if (found) return found;
  }
  if (matches.length > 1) {
    throw new RecallError(`id prefix "${needle}" is ambiguous (${matches.length} matches)`, 'EAMBIGUOUS');
  }
  throw new RecallError(`record "${needle}" not found`, 'ENOTFOUND');
}

export { REPO_ROOT, recordKey };
