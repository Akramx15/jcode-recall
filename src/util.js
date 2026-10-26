// Small, dependency-free helpers shared by every module.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VERSION = '1.1.0';
export const PROTOCOL_VERSION = '2024-11-05';

/** Boolean flags never consume the following argv element as a value. */
const BOOLEAN_FLAGS = new Set([
  'help',
  'version',
  'json',
  'stdin',
  'global',
  'literal',
  'pinned',
  'unpinned',
  'force',
  'include-superseded',
  'all',
  'quiet',
  'no-color',
  'yes',
  'markdown',
  'open',
  'verbose',
  'offline',
  'no-extract',
  'print',
  'once',
  'watch',
]);

/** Flags that may appear multiple times and collect every value. */
const REPEATABLE_FLAGS = new Set([
  'tag',
  'file',
  'constraint',
  'decision',
  'command',
  'test',
  'open-question',
  'next',
  'blocker',
  'artifact',
  'add',
  'path',
]);

/**
 * Parse argv into positionals + flags. Supports `--flag value`, `--flag=value`,
 * repeated flags, `--` terminator, and `-h` / `-v` shorthands.
 */
export function parseArgs(argv) {
  const positionals = [];
  const flags = Object.create(null);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-h' || arg === '-?') {
      flags.help = true;
      continue;
    }
    if (arg === '-v' || arg === '-V') {
      flags.version = true;
      continue;
    }
    if (typeof arg !== 'string' || !arg.startsWith('--') || arg.length <= 2) {
      positionals.push(arg);
      continue;
    }

    let key;
    let value;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      key = arg.slice(2, eq);
      value = arg.slice(eq + 1);
    } else {
      key = arg.slice(2);
      value = undefined;
    }
    key = key.toLowerCase();

    if (value === undefined) {
      const next = argv[i + 1];
      if (next !== undefined && !BOOLEAN_FLAGS.has(key) && !String(next).startsWith('--')) {
        value = next;
        i += 1;
      } else {
        value = true;
      }
    }

    if (REPEATABLE_FLAGS.has(key)) {
      if (!Array.isArray(flags[key])) flags[key] = [];
      flags[key].push(value);
    } else if (key in flags) {
      // Last one wins for scalar flags, but keep repeatable ergonomics sane.
      flags[key] = value;
    } else {
      flags[key] = value;
    }
  }

  return { positionals, flags };
}

/** Collect a repeated flag as a clean array of non-empty strings. */
export function listFlag(flags, name) {
  const raw = flags[name];
  if (raw === undefined || raw === null || raw === true) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    for (const part of item.split(/\r?\n/)) {
      const trimmed = part.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

/** True when the flag is present and not explicitly disabled. */
export function flagOn(flags, name) {
  const v = flags[name];
  if (v === undefined || v === null || v === false) return false;
  if (v === true) return true;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    return !(s === '' || s === '0' || s === 'false' || s === 'no' || s === 'off');
  }
  return Boolean(v);
}

export function asArray(value) {
  if (value === undefined || value === null || value === true || value === false) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

export function nowIso(date = new Date()) {
  return date.toISOString();
}

export function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/** Collapse all whitespace (including CRLF) to single spaces. */
export function oneLine(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

/** Truncate to a character count without splitting surrogate pairs. */
export function truncateChars(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  if (max <= 0) return '';
  let cut = max;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${s.slice(0, cut)}…`;
}

/** Rough token estimate used for every budget decision (~4 chars/token). */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

/** Hard character cap for a token budget. Never returns more than budget*4 chars. */
export function truncateToBudget(text, budgetTokens) {
  const max = Math.max(0, Math.trunc(Number(budgetTokens) || 0)) * 4;
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return s.slice(0, max);
}

/** Synchronous sleep that works on every platform (no busy loop). */
export function sleepSync(ms) {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, Math.max(0, ms));
}

export function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Expand a leading `~` to the user's home directory. */
export function expandHome(input, env = process.env) {
  const raw = String(input ?? '').trim();
  if (!raw) return raw;
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(os.homedir(), raw.slice(2));
  }
  // Support Windows-style %VAR% for convenience.
  const expanded = raw.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name) => {
    const v = env[name];
    return v === undefined ? match : v;
  });
  return expanded;
}

export function toPosixPath(p) {
  return String(p ?? '').replace(/\\/g, '/');
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Write a file atomically through a sibling temp file + rename. */
export function writeFileAtomic(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // ignore cleanup failure
    }
    throw error;
  }
  return file;
}

/**
 * Read all of stdin synchronously. Returns '' when stdin is a TTY so callers
 * never hang waiting for input that will not arrive.
 */
export function readStdinSync() {
  try {
    if (process.stdin.isTTY) return '';
    const chunks = [];
    const buf = Buffer.alloc(65536);
    for (;;) {
      let bytes;
      try {
        bytes = fs.readSync(0, buf, 0, buf.length, null);
      } catch (error) {
        if (error && (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK')) {
          sleepSync(2);
          continue;
        }
        if (error && error.code === 'EOF') break;
        throw error;
      }
      if (!bytes) break;
      chunks.push(Buffer.from(buf.subarray(0, bytes)));
    }
    return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
}

/** Split text into non-empty trimmed lines, tolerating CRLF. */
export function splitLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function formatDate(ts, { withTime = true } = {}) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts ?? 'unknown');
  const iso = d.toISOString();
  if (!withTime) return iso.slice(0, 10);
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export function daysBetween(a, b = Date.now()) {
  const t = new Date(a).getTime();
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (b - t) / 86400000);
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
