// Session import, the import ledger and the autosave loop.
//
// A Jcode session can be imported from a snapshot, a journal, or a whole
// sessions directory. Imports are idempotent: a small ledger keyed by session
// fingerprint records the last imported content hash, so running the command
// twice (or restarting a watcher) never creates duplicate records.
//
// One session produces at most one checkpoint (later journal appends update
// that checkpoint in place) and at most 40 remembered preferences.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkpoint, remember } from './service.js';
import { checkpointText, mergeHandoff } from './checkpoint.js';
import { RecallError, deepRedact } from './records.js';
import {
  canonicalKey,
  findRecordById,
  resolveHome,
  resolveProjectRoot,
  updateRecord,
} from './store.js';
import {
  extractSessionFacts,
  extractUserPreferences,
  parseJcodeSession,
  sessionFingerprint,
} from './session.js';
import {
  ensureDir,
  expandHome,
  safeJsonParse,
  toPosixPath,
  writeFileAtomic,
} from './util.js';

const LEDGER_VERSION = 1;
const LOCK_STALE_MS = 120000;
const LOCK_NAME = 'import.lock';
const DEFAULT_SINCE_DAYS = 7;
const MAX_PREFERENCES_PER_SESSION = 40;

/** Default Jcode sessions directory. Honors JCODE_HOME, then ~/.jcode. */
export function defaultSessionsDir(env = process.env) {
  const raw = env.JCODE_HOME && String(env.JCODE_HOME).trim()
    ? expandHome(String(env.JCODE_HOME).trim(), env)
    : path.join(os.homedir(), '.jcode');
  return path.join(raw, 'sessions');
}

export function importLedgerPath(home) {
  return path.join(home, 'import-state.json');
}

function emptyLedger() {
  return { version: LEDGER_VERSION, updatedAt: null, files: {}, sessions: {} };
}

function readLedger(home) {
  const file = importLedgerPath(home);
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return emptyLedger();
  }
  const parsed = safeJsonParse(raw);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) {
    return emptyLedger();
  }
  const source = parsed.value;
  return {
    version: LEDGER_VERSION,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : null,
    files: source.files && typeof source.files === 'object' && !Array.isArray(source.files) ? source.files : {},
    sessions: source.sessions && typeof source.sessions === 'object' && !Array.isArray(source.sessions) ? source.sessions : {},
  };
}

function writeLedger(home, ledger) {
  const next = {
    version: LEDGER_VERSION,
    updatedAt: new Date().toISOString(),
    files: ledger.files,
    sessions: ledger.sessions,
  };
  writeFileAtomic(importLedgerPath(home), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** Acquire the single-process import lock. Returns null when another holds it. */
export function acquireImportLock(home, { staleMs = LOCK_STALE_MS } = {}) {
  ensureDir(home);
  const lockPath = path.join(home, LOCK_NAME);

  const attempt = () => {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
      } catch {
        // The lock still exists; contents are advisory only.
      }
      return {
        path: lockPath,
        touch() {
          try {
            const now = new Date();
            fs.utimesSync(lockPath, now, now);
          } catch {
            // A missing lock is recovered by the next acquire.
          }
        },
        release() {
          try {
            fs.closeSync(fd);
          } catch {
            // ignore
          }
          try {
            fs.rmSync(lockPath, { force: true });
          } catch {
            // ignore
          }
        },
      };
    } catch (error) {
      if (error && error.code === 'EEXIST') return null;
      throw error;
    }
  };

  const first = attempt();
  if (first) return first;
  try {
    const stat = fs.statSync(lockPath);
    if (Date.now() - stat.mtimeMs > staleMs) {
      fs.rmSync(lockPath, { force: true });
      return attempt();
    }
  } catch {
    return attempt();
  }
  return null;
}

function fileStat(file) {
  try {
    const stat = fs.statSync(file);
    return stat.isFile()
      ? { file, size: stat.size, mtimeMs: stat.mtimeMs }
      : null;
  } catch {
    return null;
  }
}

function isSessionFile(name) {
  if (!name.startsWith('session_')) return false;
  if (name.endsWith('.bak') || name.endsWith('.tmp')) return false;
  return name.endsWith('.json') || name.endsWith('.jsonl');
}

function sessionStem(file) {
  return path.basename(file)
    .replace(/\.journal\.jsonl$/i, '')
    .replace(/\.jsonl$/i, '')
    .replace(/\.json$/i, '');
}

function listSessionFiles(dir) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new RecallError(`cannot read sessions directory ${dir} (${error && error.message ? error.message : error})`, 'EDIR');
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isSessionFile(entry.name)) continue;
    const stat = fileStat(path.join(dir, entry.name));
    if (stat) files.push(stat);
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file));
  return files;
}

function siblingFiles(file) {
  const dir = path.dirname(file);
  const stem = sessionStem(file);
  const candidates = [path.join(dir, `${stem}.json`), path.join(dir, `${stem}.journal.jsonl`)];
  if (path.basename(file).endsWith('.jsonl')) candidates.push(path.join(dir, `${stem}.jsonl`));
  const seen = new Set();
  const files = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const stat = fileStat(candidate);
    if (stat) files.push(stat);
  }
  return files;
}

function isEnvPath(value) {
  return /[\\/]/.test(value) || /^[A-Za-z]:/.test(value) || value.startsWith('~');
}

function resolveTargets(session, options) {
  const explicit = options.path ? path.resolve(session.cwd, expandHome(String(options.path), session.env)) : '';
  if (explicit) {
    let stat;
    try {
      stat = fs.statSync(explicit);
    } catch {
      throw new RecallError(`session path not found: ${options.path}`, 'EFILE');
    }
    if (stat.isDirectory()) return { dir: explicit, files: listSessionFiles(explicit) };
    if (!stat.isFile()) throw new RecallError(`not a file or directory: ${options.path}`, 'EFILE');
    const files = siblingFiles(explicit);
    if (!files.length) {
      const single = fileStat(explicit);
      if (single) files.push(single);
    }
    return { dir: path.dirname(explicit), files };
  }

  const dir = options.dir
    ? path.resolve(session.cwd, expandHome(String(options.dir), session.env))
    : defaultSessionsDir(session.env);
  try {
    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) throw new RecallError(`sessions path is not a directory: ${dir}`, 'EDIR');
  } catch (error) {
    if (error instanceof RecallError) throw error;
    throw new RecallError(`sessions directory not found: ${dir}`, 'EDIR');
  }
  return { dir, files: listSessionFiles(dir) };
}

function mergedMeta(parsedList) {
  const meta = {};
  for (const parsed of parsedList) {
    if (!parsed || !parsed.meta) continue;
    for (const [key, value] of Object.entries(parsed.meta)) {
      if (value !== undefined && value !== null) meta[key] = value;
    }
  }
  return meta;
}

function sortedMessages(messages) {
  const allHaveTime = messages.length > 0 && messages.every((message) => {
    const t = Date.parse(message.timestamp || '');
    return Number.isFinite(t);
  });
  if (!allHaveTime) return messages;
  return messages
    .map((message, index) => ({ message, index, t: Date.parse(message.timestamp) }))
    .sort((a, b) => a.t - b.t || a.index - b.index)
    .map((item) => item.message);
}

function mergeParsed(parsedList) {
  const ordered = [...parsedList].sort((a, b) => {
    const rank = (p) => (p.diagnostics && p.diagnostics.format === 'journal' ? 1 : 0);
    return rank(a) - rank(b) || String(a.file).localeCompare(String(b.file));
  });
  const messages = [];
  const seen = new Set();
  for (const parsed of ordered) {
    for (const message of parsed.messages || []) {
      const key = message.id || `${message.role}:${JSON.stringify(message.content)}:${message.timestamp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      messages.push(message);
    }
  }
  const first = ordered[0] || {};
  return {
    meta: mergedMeta(ordered),
    messages: sortedMessages(messages),
    file: first.file || '',
    basename: first.basename || '',
    prefix: first.prefix || '',
    diagnostics: { format: ordered.length > 1 ? 'merged' : (first.diagnostics && first.diagnostics.format) || 'unknown' },
  };
}

function contentHash(messages) {
  const canonical = messages.map((message) => [
    message.id || '',
    message.role || '',
    message.timestamp || '',
    message.content,
  ]);
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 32);
}

function sessionIdOf(meta) {
  const id = meta && (meta.id || meta.session_id || meta.sessionId);
  return typeof id === 'string' && id.trim() ? id.trim().slice(0, 160) : '';
}

function workingDirOf(meta) {
  const value = meta && (meta.working_dir || meta.workingDir || meta.cwd);
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function commandEntries(facts) {
  const out = [];
  const seen = new Set();
  const candidates = [
    ...(facts.commands || []),
    ...(facts.tests || []).map((command) => ({ command, tool: 'import', result: '', status: 'unknown' })),
  ];
  for (const candidate of candidates) {
    const command = candidate && typeof candidate === 'object'
      ? String(candidate.command || '').trim()
      : String(candidate || '').trim();
    if (!command || seen.has(command)) continue;
    seen.add(command);
    out.push({
      command,
      tool: candidate && typeof candidate === 'object' && typeof candidate.tool === 'string' ? candidate.tool : 'import',
      result: '',
      status: candidate && typeof candidate === 'object' && typeof candidate.status === 'string' ? candidate.status : 'unknown',
    });
  }
  return out.slice(0, 6);
}

function handoffData(explicit) {
  const base = {
    goal: '',
    constraints: [],
    decisions: [],
    files: [],
    commands: [],
    openQuestions: [],
    nextSteps: [],
    blockers: [],
    summary: '',
  };
  return deepRedact(mergeHandoff(base, explicit));
}

function scopeSettings(session, options) {
  const scope = options.scope === 'project';
  const provided = options.sinceDays !== undefined && options.sinceDays !== null && options.sinceDays !== '';
  const rawDays = provided ? Number(options.sinceDays) : (scope ? DEFAULT_SINCE_DAYS : null);
  const days = Number.isFinite(rawDays) && rawDays > 0 ? rawDays : 0;
  const cutoff = days > 0 ? Date.now() - (days * 86400000) : 0;

  const target = resolveProjectTarget(session, options.project);
  return {
    scope,
    days,
    cutoff,
    enforceSince: cutoff > 0 && (scope || provided),
    enforceProject: Boolean(scope) && !options.all && !target,
    expectedKey: target ? target.projectKey : canonicalKey(resolveProjectRoot(session.cwd)),
    target,
  };
}

/**
 * Turn `--project <path|name>` into a concrete project target. A resolvable
 * directory uses its canonical git root. An unresolvable bare name keeps the
 * given name as provenance and a deterministic key derived from cwd.
 */
function resolveProjectTarget(session, rawValue) {
  const value = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!value) return null;
  const expanded = expandHome(value, session.env);
  const candidate = path.resolve(session.cwd, expanded);
  if (isEnvPath(value) || fs.existsSync(candidate)) {
    const root = resolveProjectRoot(candidate);
    return {
      cwd: root,
      project: path.basename(root),
      projectPath: toPosixPath(root),
      projectKey: canonicalKey(root),
    };
  }
  return {
    cwd: session.cwd,
    project: value,
    projectPath: toPosixPath(value),
    projectKey: canonicalKey(candidate),
  };
}

/**
 * Import changed sessions once.
 *
 * `scope: 'project'` (autosave default) keeps only sessions whose
 * `meta.working_dir` resolves to the current project root and whose files were
 * modified within `sinceDays` (default 7). `all: true` drops the project
 * filter. An explicit `path` or `--dir` is always honored.
 */
function runImport(session, options, heldLock) {
  const home = resolveHome(session.env);
  ensureDir(home);
  const lock = heldLock || acquireImportLock(home);
  if (!lock) {
    return {
      busy: true,
      home,
      scanned: 0,
      imported: 0,
      checkpoints: 0,
      updated: 0,
      preferences: 0,
      unchanged: 0,
      skipped: 0,
      pending: 0,
      filteredOld: 0,
      filteredProject: 0,
      failed: 0,
      checkpointIds: [],
      lastCheckpointId: null,
      errors: [],
    };
  }

  const ownsLock = !heldLock;
  try {
    const ledger = readLedger(home);
    const target = resolveTargets(session, options);
    const scope = scopeSettings(session, options);
    const result = {
      busy: false,
      home,
      dir: target.dir,
      scanned: target.files.length,
      imported: 0,
      checkpoints: 0,
      updated: 0,
      preferences: 0,
      unchanged: 0,
      skipped: 0,
      pending: 0,
      filteredOld: 0,
      filteredProject: 0,
      failed: 0,
      checkpointIds: [],
      lastCheckpointId: null,
      errors: [],
    };

    const byStem = new Map();
    for (const entry of target.files) {
      const stem = sessionStem(entry.file);
      const list = byStem.get(stem) || [];
      list.push(entry);
      byStem.set(stem, list);
    }

    const parsedByFile = new Map();
    for (const [stem, entries] of byStem) {
      const storedFingerprint = entries
        .map((entry) => ledger.files[entry.file])
        .find((stored) => stored && typeof stored.fingerprint === 'string' && stored.fingerprint);
      const changed = entries.filter((entry) => {
        const stored = ledger.files[entry.file];
        return !(stored
          && stored.size === entry.size
          && stored.mtimeMs === entry.mtimeMs
          && typeof stored.fingerprint === 'string'
          && stored.fingerprint);
      });
      if (!changed.length) {
        result.unchanged += 1;
        continue;
      }

      const newestMtime = entries.reduce((max, entry) => Math.max(max, entry.mtimeMs), 0);
      if (scope.enforceSince && newestMtime < scope.cutoff) {
        result.filteredOld += 1;
        continue;
      }

      const parsedList = [];
      let pendingWrite = false;
      for (const entry of entries) {
        let parsed = parsedByFile.get(entry.file);
        if (!parsed) {
          parsed = parseJcodeSession(entry.file);
          parsedByFile.set(entry.file, parsed);
        }
        parsedList.push(parsed);
        if (parsed.diagnostics.pendingWrite) pendingWrite = true;
      }
      if (pendingWrite) {
        result.pending += 1;
        continue;
      }
      if (parsedList.every((parsed) => !parsed.messages.length && !parsed.meta.id && !parsed.meta.title)) {
        result.pending += 1;
        continue;
      }

      const merged = mergeParsed(parsedList);
      const meta = merged.meta || {};
      const fingerprint = sessionFingerprint({
        meta,
        prefix: merged.prefix,
        basename: merged.basename || `${stem}.json`,
      }) || (storedFingerprint || `stem:${stem}`);
      const workDir = workingDirOf(meta);

      let ctxSession = session;
      let projectOptions = {};
      let expectedKey;
      if (scope.target) {
        ctxSession = { ...session, cwd: scope.target.cwd };
        expectedKey = scope.target.projectKey;
        projectOptions = {
          project: scope.target.project,
          projectLabel: scope.target.project,
          projectPath: scope.target.projectPath,
          projectKey: scope.target.projectKey,
        };
      } else {
        if (workDir) ctxSession = { ...session, cwd: workDir };
        expectedKey = canonicalKey(resolveProjectRoot(ctxSession.cwd));
      }
      if (scope.enforceProject && expectedKey !== scope.expectedKey) {
        result.filteredProject += 1;
        continue;
      }

      const hash = contentHash(merged.messages);
      const previous = ledger.sessions[fingerprint];
      if (previous && previous.contentHash === hash) {
        result.unchanged += 1;
        for (const entry of entries) {
          ledger.files[entry.file] = {
            size: entry.size,
            mtimeMs: entry.mtimeMs,
            fingerprint,
            projectKey: expectedKey,
            workingDir: workDir || null,
          };
        }
        continue;
      }

      let facts;
      let preferences;
      try {
        facts = extractSessionFacts(merged);
        preferences = extractUserPreferences(merged);
      } catch (error) {
        result.failed += 1;
        result.errors.push(`${stem}: ${error && error.message ? error.message : error}`);
        continue;
      }

      const sessionId = sessionIdOf(meta);
      const commands = commandEntries(facts);
      const explicit = {
        goal: facts.goal,
        objectiveNow: facts.objectiveNow,
        summary: '',
        constraints: facts.constraints,
        decisions: facts.decisions,
        files: facts.filesTouched,
        commands,
        openQuestions: facts.openQuestions,
        nextSteps: facts.nextSteps,
        blockers: facts.blockers,
      };
      const hasSignal = Boolean(
        explicit.goal || explicit.objectiveNow || explicit.summary || explicit.constraints.length
        || explicit.decisions.length || explicit.files.length || commands.length
        || explicit.openQuestions.length || explicit.nextSteps.length || explicit.blockers.length,
      );

      let checkpointId = previous && previous.checkpointId ? previous.checkpointId : null;
      let preferenceTotal = Number.isFinite(previous && previous.preferences) ? Number(previous.preferences) : 0;
      let preferencesCreated = 0;

      try {
        if (hasSignal) {
          const existing = checkpointId ? findRecordById(home, checkpointId) : null;
          if (existing) {
            // One checkpoint per session: a growing journal updates it.
            const data = handoffData(explicit);
            const text = checkpointText(data, { project: path.basename(ctxSession.cwd) });
            const mergedTags = [...new Set([...(existing.record.tags || []), 'imported', 'jcode-session'])];
            updateRecord(existing.file, existing.record.id, {
              text,
              data,
              files: data.files,
              tags: mergedTags,
              task: data.goal,
              ts: new Date().toISOString(),
            });
            result.updated += 1;
          } else {
            const saved = checkpoint(ctxSession, {
              explicit,
              ...projectOptions,
              session: sessionId || fingerprint,
              source: 'import-session',
              importance: 4,
              tags: [
                'checkpoint',
                'imported',
                'jcode-session',
                ...(meta.short_name && typeof meta.short_name === 'string' ? [meta.short_name] : []),
              ],
            });
            checkpointId = saved.record.id;
            result.checkpoints += 1;
            result.checkpointIds.push(checkpointId);
            result.lastCheckpointId = checkpointId;
          }
        } else {
          result.skipped += 1;
        }

        for (const text of preferences) {
          if (preferenceTotal >= MAX_PREFERENCES_PER_SESSION) break;
          const saved = remember(ctxSession, {
            text,
            kind: 'preference',
            ...projectOptions,
            session: sessionId || fingerprint,
            source: 'import-session',
            importance: 4,
            tags: ['imported', 'jcode-session'],
          });
          preferenceTotal += 1;
          if (!saved.deduped) {
            preferencesCreated += 1;
            result.preferences += 1;
          }
        }
      } catch (error) {
        result.failed += 1;
        result.errors.push(`${stem}: ${error && error.message ? error.message : error}`);
        continue;
      }

      result.imported += 1;
      for (const entry of entries) {
        ledger.files[entry.file] = {
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          fingerprint,
          projectKey: expectedKey,
          workingDir: workDir || null,
        };
      }
      ledger.sessions[fingerprint] = {
        contentHash: hash,
        checkpointId,
        preferences: preferenceTotal,
        messages: merged.messages.length,
        importedAt: new Date().toISOString(),
        project: scope.target
          ? scope.target.project
          : (ctxSession.cwd ? path.basename(ctxSession.cwd) : null),
        projectKey: expectedKey,
        workingDir: workDir || null,
      };
    }

    writeLedger(home, ledger);
    return result;
  } finally {
    if (ownsLock) lock.release();
  }
}

/** Import changed sessions once, synchronously (used by the MCP server). */
export function importSessionsSync(session, options = {}) {
  return runImport(session, options, options.lock || null);
}

/** Import changed sessions once. */
export async function importSessions(session, options = {}) {
  return importSessionsSync(session, options);
}

/** One-line, human-readable import summary. */
export function formatImportSummary(result) {
  if (!result) return 'recall: import produced no result';
  if (result.busy) return 'recall: another import is already running; nothing imported';
  const bits = [
    `imported ${result.imported} session(s)`,
    `${result.checkpoints} checkpoint(s)`,
    `${result.updated || 0} updated`,
    `${result.preferences} preference(s)`,
  ];
  if (result.unchanged) bits.push(`${result.unchanged} unchanged`);
  if (result.skipped) bits.push(`${result.skipped} without facts`);
  if (result.filteredOld) bits.push(`${result.filteredOld} older than window`);
  if (result.filteredProject) bits.push(`${result.filteredProject} other project`);
  if (result.pending) bits.push(`${result.pending} pending write`);
  if (result.failed) bits.push(`${result.failed} failed`);
  const tail = result.lastCheckpointId ? `; checkpoint ${result.lastCheckpointId}` : '';
  return `recall: ${bits.join(', ')}${tail}`;
}

/**
 * Poll the sessions directory until aborted or until SIGINT (when
 * `handleSignals` is set). Returns a small run summary.
 */
export function watchSessions(session, options = {}) {
  const intervalMs = Math.max(10, Number.isFinite(Number(options.intervalMs)) ? Number(options.intervalMs) : 30000);
  const home = resolveHome(session.env);
  const lock = options.lock || acquireImportLock(home);
  if (!lock) {
    return Promise.resolve({ busy: true, passes: 0, imported: 0, checkpoints: 0 });
  }

  return new Promise((resolve) => {
    let stopped = false;
    let timer = null;
    let passes = 0;
    let imported = 0;
    let checkpoints = 0;
    const errors = [];

    const stop = (reason) => {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (options.handleSignals) process.removeListener('SIGINT', onSigint);
      lock.release();
      resolve({ busy: false, stopped: true, reason, passes, imported, checkpoints, errors });
    };
    const onSigint = () => stop('SIGINT');

    if (options.handleSignals) process.once('SIGINT', onSigint);
    if (options.signal) {
      if (options.signal.aborted) {
        stop('aborted');
        return;
      }
      options.signal.addEventListener('abort', () => stop('aborted'), { once: true });
    }

    const tick = async () => {
      if (stopped) return;
      lock.touch();
      try {
        const result = await runImport(session, options, lock);
        passes += 1;
        imported += result.imported || 0;
        checkpoints += result.checkpoints || 0;
        if (result.errors && result.errors.length) errors.push(...result.errors);
        if (typeof options.onTick === 'function') {
          try {
            options.onTick(result, { pass: passes });
          } catch {
            // A reporting callback must never stop the watcher.
          }
        }
      } catch (error) {
        passes += 1;
        errors.push(error && error.message ? error.message : String(error));
      }
      if (!stopped) timer = setTimeout(tick, intervalMs);
    };

    tick();
  });
}
