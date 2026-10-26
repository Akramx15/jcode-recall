// Deterministic retrieval: BM25 over text/tags/files + recency/importance/
// project/pin boosts, plus a literal substring mode. No embeddings, no network.

import { daysBetween, toPosixPath } from './util.js';
import { looseKey, normalizeText, tokenize, tokenizePath } from './text.js';
import { recordKey, recordMatches } from './store.js';

const K1 = 1.2;
const B = 0.75;
const RECENCY_HALF_LIFE_DAYS = 30;
const TOKEN_CACHE_LIMIT = 20000;
const tokenCache = new Map();

/** Records that may appear in results. */
export function visibleRecords(records, { includeSuperseded = false, includePinned = true } = {}) {
  return records.filter((record) => {
    if (record.supersededBy && !includeSuperseded) return false;
    if (!includePinned && record.pinned) return false;
    return true;
  });
}

function docSignature(record) {
  return `${record.id}\u0000${record.updatedTs || record.ts}\u0000${record.text.length}\u0000${(record.tags || []).length}\u0000${(record.files || []).length}`;
}

function docTokens(record) {
  const signature = docSignature(record);
  const cached = tokenCache.get(signature);
  if (cached) return cached;

  const tokens = tokenize(record.text);
  for (const tag of record.tags || []) {
    const tagTokens = tokenize(tag);
    // Tags are strong signals: count them twice.
    tokens.push(...tagTokens, ...tagTokens);
  }
  for (const file of record.files || []) {
    tokens.push(...tokenizePath(file));
  }

  if (tokenCache.size >= TOKEN_CACHE_LIMIT) tokenCache.clear();
  tokenCache.set(signature, tokens);
  return tokens;
}

function boost(record, { boostKey, now }) {
  const ageDays = daysBetween(record.ts, now);
  const recency = Number.isFinite(ageDays) ? Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS) : 0;
  let factor = 1 + 0.6 * recency;

  const importance = Number.isFinite(record.importance) ? record.importance : 3;
  factor *= 1 + 0.15 * (importance - 3);

  if (boostKey && recordKey(record) === boostKey) factor *= 1.25;
  if (record.pinned) factor *= 1.6;
  if (record.supersededBy) factor *= 0.2;
  return factor;
}

function matchesTag(record, tag) {
  const want = looseKey(tag);
  if (!want) return true;
  return (record.tags || []).some((t) => looseKey(t) === want);
}

function matchesFile(record, file) {
  const want = toPosixPath(String(file ?? '')).trim().toLowerCase();
  if (!want) return true;
  const wantBase = want.split('/').filter(Boolean).pop();
  return (record.files || []).some((f) => {
    const candidate = toPosixPath(f).toLowerCase();
    if (candidate === want) return true;
    if (candidate.endsWith(`/${want}`)) return true;
    if (wantBase && candidate.split('/').pop() === wantBase) return true;
    return false;
  });
}

export function filterRecords(records, opts = {}) {
  const pool = visibleRecords(records, { includeSuperseded: Boolean(opts.includeSuperseded) });
  const kind = opts.kind ? String(opts.kind).trim().toLowerCase() : '';
  return pool.filter((record) => {
    if (kind && record.kind !== kind) return false;
    if (opts.tag && !matchesTag(record, opts.tag)) return false;
    if (opts.file && !matchesFile(record, opts.file)) return false;
    if (opts.selector && !recordMatches(record, opts.selector)) return false;
    if (opts.pinnedOnly && !record.pinned) return false;
    return true;
  });
}

function literalHits(records, query, opts) {
  const needle = normalizeText(query).replace(/\s+/g, ' ').trim();
  if (!needle) return [];
  const results = [];
  for (const record of records) {
    const haystack = normalizeText([
      record.text,
      (record.tags || []).join(' '),
      (record.files || []).join(' '),
    ].join(' ')).replace(/\s+/g, ' ');
    let count = 0;
    let index = haystack.indexOf(needle);
    while (index !== -1 && count < 100) {
      count += 1;
      index = haystack.indexOf(needle, index + needle.length);
    }
    if (!count) continue;
    const base = 1 + Math.log2(1 + count);
    results.push({ record, score: base * boost(record, opts), matches: count });
  }
  return results;
}

/**
 * Rank records for a query.
 * @returns {Array<{record: object, score: number}>} best first
 */
export function rankRecords(records, query, opts = {}) {
  const now = opts.now ?? Date.now();
  const context = { boostKey: opts.boostKey || (opts.selector && opts.selector.key) || '', now };
  const pool = filterRecords(records, opts);

  if (opts.literal) {
    return literalHits(pool, query, context).sort(compareHits);
  }

  const queryTokens = tokenize(query);
  if (!queryTokens.length) return [];
  const queryTerms = new Map();
  for (const token of queryTokens) {
    queryTerms.set(token, (queryTerms.get(token) || 0) + 1);
  }

  const docs = pool.map((record) => {
    const tokens = docTokens(record);
    const tf = new Map();
    for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1);
    return { record, tf, length: tokens.length };
  });
  if (!docs.length) return [];

  const avgdl = docs.reduce((sum, doc) => sum + doc.length, 0) / docs.length || 1;
  const df = new Map();
  for (const doc of docs) {
    for (const term of queryTerms.keys()) {
      if (doc.tf.has(term)) df.set(term, (df.get(term) || 0) + 1);
    }
  }

  const total = docs.length;
  const results = [];
  for (const doc of docs) {
    let score = 0;
    for (const [term, qtf] of queryTerms) {
      const tf = doc.tf.get(term) || 0;
      if (!tf) continue;
      const docFreq = df.get(term) || 0;
      const idf = Math.log(1 + (total - docFreq + 0.5) / (docFreq + 0.5));
      const denom = tf + K1 * (1 - B + (B * doc.length) / avgdl);
      score += idf * ((tf * (K1 + 1)) / denom) * Math.min(qtf, 3);
    }
    if (score <= 0) continue;
    results.push({ record: doc.record, score: score * boost(doc.record, context) });
  }

  return results.sort(compareHits);
}

function compareHits(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const ta = new Date(a.record.ts).getTime();
  const tb = new Date(b.record.ts).getTime();
  if (tb !== ta) return tb - ta;
  return String(b.record.id).localeCompare(String(a.record.id));
}

/** Round scores for display without changing sort order. */
export function displayScore(score) {
  return Math.round(score * 100) / 100;
}

export function limitResults(results, limit) {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return results;
  return results.slice(0, Math.trunc(n));
}
