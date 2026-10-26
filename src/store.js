// Append-only JSONL storage with cross-process locking.
//
// Layout (default ~/.jcode/recall):
//   global.jsonl
//   proj-<slug>-<hash>.jsonl
//
// Invariants:
//   * Records are never rewritten in place; updates/deletes are appended as
//     `_op` lines and merged on read.
//   * Malformed lines are counted and skipped; reads never throw.
//   * A single process-wide file lock serializes appends on Windows, macOS and
//     Linux, so concurrent agents cannot interleave partial lines.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

import {
  ensureDir,
  expandHome,
  oneLine,
  sleepSync,
  toPosixPath,
} from './util.js';
import { normalizeForDedupe, slugify } from './text.js';

export const GLOBAL_PROJECT = 'global';
export const DATA_SUFFIX = '.jsonl';
const LOCK_STALE_MS = 15000;
const LOCK_TIMEOUT_MS = 20000;

export function resolveHome(env = process.env) {
  const raw = env.RECALL_HOME;
  if (raw && String(raw).trim()) {
    return path.resolve(expandHome(String(raw).trim(), env));
  }
  return path.join(os.homedir(), '.jcode', 'recall');
}

/**
 * Canonical identity for a project root.
 * - absolute, forward slashes, no trailing slash
 * - lowercased on Windows (case-insensitive filesystem)
 */
export function canonicalKey(project) {
  let key = toPosixPath(path.resolve(String(project ?? '').trim())).replace(/\/+$/g, '');
  if (!key) key = '/';
  if (process.platform === 'win32') key = key.toLowerCase();
  return key;
}

/** Lowercase comparison for human project labels. */
export function normalizeLabel(label) {
  return toPosixPath(String(label ?? '').trim()).replace(/\/+$/g, '').toLowerCase();
}

function posixBasename(p) {
  const posix = toPosixPath(String(p ?? '')).replace(/\/+$/g, '');
  const base = posix.split('/').filter(Boolean).pop() || '';
  return base || 'default';
}

function findGitRoot(start) {
  let current = path.resolve(start);
  for (let depth = 0; depth < 40; depth += 1) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

/**
 * Resolve the canonical project root for a directory. Prefers the git
 * top-level so two subdirectories of one repo share a memory file, and two
 * unrelated repos with the same basename never do.
 */
const projectRootCache = new Map();

export function resolveProjectRoot(cwd) {
  const base = path.resolve(String(cwd ?? process.cwd()));
  const cached = projectRootCache.get(base);
  if (cached) return cached;

  const gitRoot = findGitRoot(base);
  if (!gitRoot) {
    projectRootCache.set(base, base);
    return base;
  }

  let root = gitRoot;
  try {
    const result = spawnSync('git', ['-C', gitRoot, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result && result.status === 0 && typeof result.stdout === 'string' && result.stdout.trim()) {
      root = path.resolve(result.stdout.trim());
    }
  } catch {
    // git is optional; fall back to the directory containing .git
  }

  if (projectRootCache.size > 1000) projectRootCache.clear();
  projectRootCache.set(base, root);
  return root;
}

/** Stable file name derived from the canonical project key, never the label. */
export function projectFile(home, projectKey) {
  const key = String(projectKey || 'default');
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
  const slug = slugify(posixBasename(key)).slice(0, 32).replace(/-+$/g, '') || 'project';
  return path.join(home, `proj-${slug}-${hash}${DATA_SUFFIX}`);
}

export function globalFile(home) {
  return path.join(home, `global${DATA_SUFFIX}`);
}

function looksLikePath(value) {
  return /[\\/]/.test(value) || /^[A-Za-z]:/.test(value);
}

/**
 * Resolve the effective home, human label, canonical key, and target file.
 *
 * `project` is only a label. Identity always comes from `projectKey`, which is
 * the git top-level (or absolute cwd) with forward slashes, lowercased on
 * Windows.
 */
export function resolveContext(flags = {}, { env = process.env, cwd = process.cwd() } = {}) {
  const home = resolveHome(env);
  const flagProject = typeof flags.project === 'string' && flags.project.trim() ? flags.project.trim() : '';
  const envProject = env.RECALL_PROJECT && String(env.RECALL_PROJECT).trim() ? String(env.RECALL_PROJECT).trim() : '';
  const baseRoot = resolveProjectRoot(cwd);

  if (flags.global) {
    return {
      home,
      project: GLOBAL_PROJECT,
      projectKey: GLOBAL_PROJECT,
      projectPath: null,
      file: globalFile(home),
      globalFile: globalFile(home),
      isGlobal: true,
      explicitProject: false,
      root: baseRoot,
    };
  }

  let root = baseRoot;
  let project = posixBasename(baseRoot);
  let explicitProject = false;

  const requested = flagProject || envProject;
  if (requested) {
    explicitProject = true;
    if (looksLikePath(requested)) {
      root = resolveProjectRoot(path.resolve(cwd, expandHome(requested, env)));
      project = posixBasename(root);
    } else {
      project = requested;
    }
  }

  const projectKey = canonicalKey(root);
  const projectPath = toPosixPath(root);
  const file = projectFile(home, projectKey);

  return {
    home,
    project,
    projectKey,
    projectPath,
    file,
    globalFile: globalFile(home),
    isGlobal: false,
    explicitProject,
    root,
  };
}

/** Canonical key of a loaded record; falls back to its stored path. */
export function recordKey(record) {
  if (!record) return '';
  if (typeof record.projectKey === 'string' && record.projectKey) return record.projectKey;
  if (typeof record.projectPath === 'string' && record.projectPath) return canonicalKey(record.projectPath);
  if (record.project === GLOBAL_PROJECT) return GLOBAL_PROJECT;
  return '';
}

/**
 * Build a selector for a user-supplied `--project` value.
 * A path matches by canonical key; a bare name matches only project labels.
 */
export function projectSelector(value, { cwd = process.cwd(), env = process.env } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw || raw === 'all') return null;
  if (looksLikePath(raw)) {
    const root = resolveProjectRoot(path.resolve(cwd, expandHome(raw, env)));
    return { key: canonicalKey(root), label: posixBasename(root), explicit: true, path: toPosixPath(root) };
  }
  return { label: raw, explicit: true };
}

/** True when a record belongs to a selector. Global records are shared. */
export function recordMatches(record, selector) {
  if (!selector) return true;
  if (record.project === GLOBAL_PROJECT) return true;
  if (selector.key) return recordKey(record) === selector.key;
  if (selector.label) return normalizeLabel(record.project) === normalizeLabel(selector.label);
  return false;
}

/** Backwards-compatible helper: exact key match unless `explicit` is true. */
export function projectMatches(record, project, { explicit = false } = {}) {
  if (!project || project === 'all') return true;
  if (record.project === GLOBAL_PROJECT) return true;
  if (!explicit) return recordKey(record) === canonicalKey(project);
  return normalizeLabel(record.project) === normalizeLabel(project)
    || recordKey(record) === canonicalKey(project);
}

function withLock(file, fn) {
  ensureDir(path.dirname(file));
  const lockPath = `${file}.lock`;
  const started = Date.now();
  let fd = null;

  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      break;
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const stat = fs.statSync(lockPath);
        stale = Date.now() - stat.mtimeMs > LOCK_STALE_MS;
      } catch {
        // Lock disappeared between open and stat: retry immediately.
        continue;
      }
      if (stale) {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          // Another process may have removed it first; just retry.
        }
        continue;
      }
      if (Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new Error(`recall: timed out waiting for lock ${lockPath}`);
      }
      sleepSync(4);
    }
  }

  try {
    return fn();
  } finally {
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
  }
}

function writeAllSync(fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const written = fs.writeSync(fd, buffer, offset, buffer.length - offset);
    if (!written) throw new Error('recall: short write while appending record');
    offset += written;
  }
}

/** Append a single JSON line under lock. Returns the parsed object. */
export function appendObject(file, obj) {
  const line = `${JSON.stringify(obj)}\n`;
  const buffer = Buffer.from(line, 'utf8');
  withLock(file, () => {
    const fd = fs.openSync(file, 'a');
    try {
      writeAllSync(fd, buffer);
      try {
        fs.fsyncSync(fd);
      } catch {
        // fsync is best-effort (some filesystems refuse it).
      }
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
    invalidateFileCache(file);
  });
  return obj;
}

function isValidRecordShape(obj) {
  return Boolean(
    obj
      && typeof obj === 'object'
      && !Array.isArray(obj)
      && typeof obj.id === 'string'
      && obj.id.length > 0
      && typeof obj.text === 'string'
      && obj.text.trim().length > 0,
  );
}

function normalizeLoadedRecord(obj) {
  const record = { ...obj };
  record.project = typeof record.project === 'string' && record.project ? record.project : GLOBAL_PROJECT;
  if (typeof record.projectPath === 'string' && record.projectPath && typeof record.projectKey !== 'string') {
    record.projectKey = record.project === GLOBAL_PROJECT ? GLOBAL_PROJECT : canonicalKey(record.projectPath);
  }
  if (record.project === GLOBAL_PROJECT) {
    record.projectKey = GLOBAL_PROJECT;
  } else if (typeof record.projectKey !== 'string' || !record.projectKey) {
    record.projectKey = typeof record.projectPath === 'string' && record.projectPath
      ? canonicalKey(record.projectPath)
      : '';
  }
  record.kind = typeof record.kind === 'string' && record.kind ? record.kind : 'fact';
  record.tags = Array.isArray(record.tags) ? record.tags.filter((t) => typeof t === 'string') : [];
  record.files = Array.isArray(record.files) ? record.files.filter((f) => typeof f === 'string') : [];
  record.importance = Number.isFinite(Number(record.importance)) ? Math.min(5, Math.max(1, Math.trunc(Number(record.importance)))) : 3;
  record.ts = typeof record.ts === 'string' && !Number.isNaN(new Date(record.ts).getTime())
    ? record.ts
    : new Date(0).toISOString();
  record.pinned = record.pinned === true;
  return record;
}

function applyLine(map, obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;

  if (obj._op === 'update' && typeof obj.id === 'string') {
    const existing = map.get(obj.id);
    if (existing) {
      const patch = obj.patch && typeof obj.patch === 'object' ? obj.patch : {};
      const next = { ...existing };
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'id' || key === '_op') continue;
        next[key] = value;
      }
      next.updatedTs = typeof obj.ts === 'string' ? obj.ts : new Date().toISOString();
      map.set(obj.id, normalizeLoadedRecord(next));
      return true;
    }
    return false;
  }

  if (obj._op === 'delete' && typeof obj.id === 'string') {
    return map.delete(obj.id);
  }

  if (!isValidRecordShape(obj)) return false;
  const existing = map.get(obj.id);
  if (existing) {
    map.set(obj.id, normalizeLoadedRecord({ ...existing, ...obj }));
  } else {
    map.set(obj.id, normalizeLoadedRecord(obj));
  }
  return true;
}

/**
 * Read one JSONL file. Returns records in file order (post-op) plus diagnostics.
 * Never throws for malformed content.
 */
const fileCache = new Map();

/** Drop a cached parse for one file (called after writes). */
export function invalidateFileCache(file) {
  fileCache.delete(file);
}

export function readFileRecords(file) {
  const empty = { file, records: [], lines: 0, malformed: 0, bytes: 0, exists: false };
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    fileCache.delete(file);
    return empty;
  }
  if (!stat.isFile()) return empty;

  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs && cached.size === stat.size) {
    return cached.result;
  }

  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return empty;
    return { ...empty, error };
  }

  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const wasTruncated = raw.length > 0 && !raw.endsWith('\n');
  const lines = raw.split(/\r?\n/);
  const map = new Map();
  let malformed = 0;
  let counted = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    counted += 1;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (!applyLine(map, parsed)) malformed += 1;
  }

  const result = {
    file,
    records: [...map.values()],
    lines: counted,
    malformed,
    bytes: Buffer.byteLength(raw, 'utf8'),
    exists: true,
    truncatedTail: wasTruncated,
  };
  fileCache.set(file, {
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    size: stat.size,
    result,
  });
  return result;
}

export function listDataFiles(home) {
  let entries = [];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(DATA_SUFFIX))
    .map((e) => e.name)
    .sort((a, b) => {
      if (a === `global${DATA_SUFFIX}`) return -1;
      if (b === `global${DATA_SUFFIX}`) return 1;
      return a.localeCompare(b);
    });
  return names.map((name) => path.join(home, name));
}

/** Load every record from every project file, sorted oldest → newest. */
export function loadAllRecords(home) {
  const files = listDataFiles(home);
  const map = new Map();
  let malformed = 0;
  let lines = 0;

  for (const file of files) {
    const result = readFileRecords(file);
    malformed += result.malformed;
    lines += result.lines;
    for (const record of result.records) {
      const existing = map.get(record.id);
      if (existing) {
        // Later files win only if they carry a newer timestamp.
        if (new Date(record.ts) >= new Date(existing.ts)) map.set(record.id, record);
      } else {
        map.set(record.id, record);
      }
    }
  }

  const records = [...map.values()].sort((a, b) => {
    const byTs = new Date(a.ts).getTime() - new Date(b.ts).getTime();
    if (byTs !== 0) return byTs;
    return String(a.id).localeCompare(String(b.id));
  });

  return { records, malformed, lines, files };
}

/** True when an identical (normalized) text already exists in the same project key. */
export function findDuplicate(records, { text, projectKey }) {
  const target = normalizeForDedupe(text).replace(/\s+/g, ' ').toLowerCase();
  if (!target) return null;
  for (const record of records) {
    if (record.deleted) continue;
    if (record.supersededBy) continue;
    if (recordKey(record) !== projectKey) continue;
    const candidate = normalizeForDedupe(record.text).replace(/\s+/g, ' ').toLowerCase();
    if (candidate === target) return record;
  }
  return null;
}

/**
 * Insert a record with dedupe, fully under the file lock so two processes
 * cannot both append the same text.
 *
 * @returns {{record: object, deduped: boolean, merged: boolean}}
 */
export function insertRecord(file, record, { dedupe = true } = {}) {
  return withLock(file, () => {
    const existing = readFileRecords(file);
    if (dedupe) {
      const duplicate = findDuplicate(existing.records, {
        text: record.text,
        projectKey: recordKey(record),
      });
      if (duplicate) {
        const mergedTags = [...new Set([...(duplicate.tags || []), ...(record.tags || [])])];
        const mergedFiles = [...new Set([...(duplicate.files || []), ...(record.files || [])])];
        const changed = mergedTags.length !== (duplicate.tags || []).length
          || mergedFiles.length !== (duplicate.files || []).length;
        if (changed) {
          const patch = {};
          if (mergedTags.length !== (duplicate.tags || []).length) patch.tags = mergedTags;
          if (mergedFiles.length !== (duplicate.files || []).length) patch.files = mergedFiles;
          appendObjectUnlocked(file, {
            _op: 'update',
            id: duplicate.id,
            patch,
            ts: record.ts,
          });
        }
        return { record: { ...duplicate, tags: mergedTags, files: mergedFiles }, deduped: true, merged: changed };
      }
    }

    appendObjectUnlocked(file, record);
    return { record, deduped: false, merged: false };
  });
}

function appendObjectUnlocked(file, obj) {
  const line = `${JSON.stringify(obj)}\n`;
  const buffer = Buffer.from(line, 'utf8');
  const fd = fs.openSync(file, 'a');
  try {
    writeAllSync(fd, buffer);
    try {
      fs.fsyncSync(fd);
    } catch {
      // ignore
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
  invalidateFileCache(file);
  return obj;
}

/** Append an update patch for an existing record. */
export function updateRecord(file, id, patch) {
  return withLock(file, () => {
    const existing = readFileRecords(file).records.find((r) => r.id === id);
    if (!existing) return null;
    const ts = new Date().toISOString();
    appendObjectUnlocked(file, { _op: 'update', id, patch, ts });
    return { ...existing, ...patch, updatedTs: ts };
  });
}

/** Append a delete op. Returns the removed record or null. */
export function deleteRecord(file, id) {
  return withLock(file, () => {
    const existing = readFileRecords(file).records.find((r) => r.id === id);
    if (!existing) return null;
    appendObjectUnlocked(file, { _op: 'delete', id, ts: new Date().toISOString() });
    return existing;
  });
}

/** Locate a record by id across every project file. */
export function findRecordById(home, id) {
  for (const file of listDataFiles(home)) {
    const found = readFileRecords(file).records.find((r) => r.id === id);
    if (found) return { record: found, file };
  }
  return null;
}

/** Per-file diagnostics for `stats` and `doctor`. */
export function fileDiagnostics(home) {
  return listDataFiles(home).map((file) => {
    const result = readFileRecords(file);
    return {
      file,
      name: path.basename(file),
      bytes: result.bytes,
      lines: result.lines,
      malformed: result.malformed,
      records: result.records.length,
      truncatedTail: Boolean(result.truncatedTail),
    };
  });
}

export function summarize(records, home) {
  const byKind = Object.create(null);
  const byProject = Object.create(null);
  const projectMap = new Map();
  let pinned = 0;
  let withFiles = 0;
  let tokens = 0;
  let oldest = null;
  let newest = null;

  for (const record of records) {
    byKind[record.kind] = (byKind[record.kind] || 0) + 1;
    const key = recordKey(record) || record.project;
    byProject[key] = (byProject[key] || 0) + 1;
    const entry = projectMap.get(key) || {
      key,
      label: record.project,
      path: record.projectPath || null,
      count: 0,
    };
    entry.count += 1;
    projectMap.set(key, entry);
    if (record.pinned) pinned += 1;
    if (record.files && record.files.length) withFiles += 1;
    tokens += Math.ceil(String(record.text || '').length / 4);
    const t = new Date(record.ts).getTime();
    if (Number.isFinite(t)) {
      if (oldest === null || t < oldest) oldest = t;
      if (newest === null || t > newest) newest = t;
    }
  }

  return {
    home,
    total: records.length,
    pinned,
    withFiles,
    approxTokens: tokens,
    byKind,
    byProject,
    projects: [...projectMap.values()].sort((a, b) => b.count - a.count),
    oldest: oldest === null ? null : new Date(oldest).toISOString(),
    newest: newest === null ? null : new Date(newest).toISOString(),
  };
}

/**
 * Compact path for display: keep the last two segments, which is enough to
 * identify a file without leaking a full home directory into prompts.
 */
export function shortPath(p) {
  const posix = toPosixPath(p);
  const parts = posix.split('/').filter(Boolean);
  if (parts.length <= 2) return posix;
  return parts.slice(-2).join('/');
}

export function describeContext(ctx) {
  const location = ctx.projectPath ? oneLine(shortPath(ctx.projectPath)) : 'global';
  return `${ctx.project} (${location})`;
}
