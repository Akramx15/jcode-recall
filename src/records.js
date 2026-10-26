// Record construction, validation and lightweight safety checks.

import crypto from 'node:crypto';

import { clampInt, nowIso, oneLine, toPosixPath } from './util.js';

export const KINDS = ['fact', 'decision', 'preference', 'task', 'artifact', 'handoff', 'snippet'];

export const KIND_ALIASES = new Map([
  ['facts', 'fact'],
  ['decisions', 'decision'],
  ['preferences', 'preference'],
  ['pref', 'preference'],
  ['tasks', 'task'],
  ['todo', 'task'],
  ['artifacts', 'artifact'],
  ['file', 'artifact'],
  ['handoffs', 'handoff'],
  ['checkpoint', 'handoff'],
  ['snippets', 'snippet'],
  ['code', 'snippet'],
]);

export class RecallError extends Error {
  constructor(message, code = 'ERECALL') {
    super(message);
    this.name = 'RecallError';
    this.code = code;
  }
}

export function normalizeKind(value, fallback = 'fact') {
  if (typeof value !== 'string') return fallback;
  const key = value.trim().toLowerCase();
  if (!key) return fallback;
  if (KINDS.includes(key)) return key;
  if (KIND_ALIASES.has(key)) return KIND_ALIASES.get(key);
  throw new RecallError(`unknown kind "${value}" (expected one of: ${KINDS.join(', ')})`, 'EKIND');
}

export function newId(prefix = 'r') {
  const time = Date.now().toString(36);
  const rand = crypto.randomBytes(3).toString('hex');
  return `${prefix}${time}${rand}`;
}

export function normalizeTags(input) {
  const out = [];
  const seen = new Set();
  const raw = Array.isArray(input) ? input : input === undefined || input === null ? [] : [input];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    for (const piece of item.split(/[,\n]/)) {
      const tag = oneLine(piece).replace(/^#+/, '').slice(0, 48);
      if (!tag) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
      if (out.length >= 24) return out;
    }
  }
  return out;
}

export function normalizeFiles(input) {
  const out = [];
  const seen = new Set();
  const raw = Array.isArray(input) ? input : input === undefined || input === null ? [] : [input];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const file = item.trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/').slice(0, 400);
    if (!file) continue;
    const key = file.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
    if (out.length >= 64) return out;
  }
  return out;
}

export function normalizeTextValue(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n?/g, '\n').trim();
}

export function normalizeImportance(value, fallback = 3) {
  return clampInt(value, 1, 5, fallback);
}

const SECRET_PATTERNS = [
  { label: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'OpenAI-style key', re: /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}/ },
  { label: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { label: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { label: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { label: 'password assignment', re: /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token)\b\s*[:=]\s*\S{6,}/i },
  { label: 'connection string with credentials', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i },
];

/** Return human labels for likely secrets. The values are never returned. */
export function detectSecrets(text) {
  const labels = [];
  const sample = String(text ?? '');
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.re.test(sample)) labels.push(pattern.label);
  }
  return labels;
}

/** Replace secret-looking spans with a label so they never reach disk. */
export function redactSecrets(text) {
  let out = String(text ?? '');
  for (const pattern of SECRET_PATTERNS) {
    const flags = pattern.re.flags.includes('g') ? pattern.re.flags : `${pattern.re.flags}g`;
    const global = new RegExp(pattern.re.source, flags);
    out = out.replace(global, `[redacted:${pattern.label}]`);
  }
  return out;
}

/** Redact every string inside a JSON-like structure. */
export function deepRedact(value, depth = 0) {
  if (depth > 12) return value;
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => deepRedact(item, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = deepRedact(item, depth + 1);
    return out;
  }
  return value;
}

export function buildRecord(input, { now = new Date() } = {}) {
  const text = normalizeTextValue(input.text);
  if (!text) throw new RecallError('text is required (pass it as an argument or with --stdin)', 'ETEXT');
  if (text.length > 200000) throw new RecallError('text is too large (limit 200000 characters)', 'ETEXT');

  const project = typeof input.project === 'string' && input.project.trim()
    ? input.project.trim()
    : 'default';

  const record = {
    id: typeof input.id === 'string' && input.id.trim() ? input.id.trim() : newId('r'),
    ts: nowIso(now),
    project,
    kind: normalizeKind(input.kind, 'fact'),
    text,
    tags: normalizeTags(input.tags),
    files: normalizeFiles(input.files),
    importance: normalizeImportance(input.importance, 3),
    session: typeof input.session === 'string' && input.session.trim() ? input.session.trim().slice(0, 120) : 'default',
    source: typeof input.source === 'string' && input.source.trim() ? input.source.trim().slice(0, 60) : 'cli',
    pinned: input.pinned === true,
  };

  if (input.projectPath) record.projectPath = toPosixPath(input.projectPath);
  if (input.projectKey) record.projectKey = String(input.projectKey);
  if (record.project === 'global') record.projectKey = 'global';
  if (input.data && typeof input.data === 'object' && !Array.isArray(input.data)) {
    record.data = input.data;
  }
  if (typeof input.task === 'string' && input.task.trim()) {
    record.task = input.task.trim().slice(0, 500);
  }

  return record;
}
