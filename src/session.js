// Jcode session parsing and deterministic fact extraction.
//
// Jcode stores two related shapes under ~/.jcode/sessions:
//   session_<name>_<id>.json          full snapshot (metadata at the top level,
//                                     plus `messages`)
//   session_<name>_<id>.journal.jsonl append-only lines shaped
//                                     {meta, append_messages}
//
// This module is pure: it reads one file, tolerates malformed lines, unknown
// block types, BOM and CRLF, and never throws for bad input. Extraction is
// heuristic and conservative: every emitted item comes from the transcript.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { commandStatus } from './checkpoint.js';
import { deepRedact } from './records.js';
import { looseKey } from './text.js';
import { oneLine, toPosixPath, truncateChars } from './util.js';

const MAX_TEXT = 240;
const MAX_ITEMS = 12;
const MAX_PROMPTS = 20;
const MAX_MESSAGE_CHARS = 40000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PROSE_CHARS = 1500;
const MAX_USER_PROMPT_CHARS = 8000;
const MAX_DECISIONS = 8;
const MAX_NEXT_STEPS = 6;
const MAX_BLOCKERS = 4;
const MAX_PREFERENCES = 10;

const CONSTRAINT_RE = /\b(?:must|must not|never|always|do not|don't|avoid|only use|required|constraint|not allowed)\b|يجب|لا يجب|ممنوع|قيود|شرط/i;
const DECISION_RE = /\b(?:decided|decision|we chose|we picked|switched to|going with|will use|we'll use|we will use|opted for|instead of|rather than|because)\b|قرر|قررنا|اخترنا|سنستخدم|نستخدم|بدلاً|بدلا|لأن|لان/i;
const NEXT_RE = /\b(?:next\b|then\b|after that\b|todo\b|remaining\b|follow[- ]?up\b|pending\b|still need\b)|الخطوة التالية|التالي|بعد ذلك|المتبقي|ما زال/i;
const BLOCKER_RE = /\b(?:blocked|blocker|cannot proceed|can't proceed|not working|broken|error:|fails? because|failed)\b|عائق|محظور|لا يعمل|خطأ|فشل/i;
const QUESTION_RE = /\b(?:open question|unclear|not sure|need to confirm|which approach|should we)\b|غير واضح|سؤال|هل /i;
const SCHEMA_MARKER_RE = /"(?:type|description|properties|input_schema|inputSchema|required|enum|default|items|additionalProperties|anyOf|oneOf)"\s*:|input_schema|inputSchema|\bmcp__|"properties"\s*:|"type"\s*:/i;
const TOOL_DOC_RE = /^\s*(?:use for|parameters?|returns?|arguments?)\s*:|inspect_analysis_view|request cancellation|click target|\btool schema\b|output_schema|input schema/i;

const FILE_EXTENSIONS = [
  'rs', 'ts', 'tsx', 'js', 'jsx', 'py', 'go', 'java', 'kt', 'swift',
  'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'sh', 'ps1', 'cmd',
  'toml', 'json', 'yaml', 'yml', 'md', 'sql', 'css', 'html',
];
const FILE_RE = new RegExp(
  `(?:\\.{1,2}[\\\\/])?(?:[\\w@.+-]+[\\\\/])*[\\w@.+-]+\\.(?:${FILE_EXTENSIONS.join('|')})\\b`,
  'gi',
);
const STATE_COMMAND_RE = /^(?:npm\s+(?:test|run|install|ci|exec|start)\b|pnpm\s+(?:test|run|install|add|exec)\b|yarn\s+(?:test|run|install|add)\b|npx\s+(?:jest|vitest|tsc|eslint|prettier)\b|node\b|cargo\s+(?:test|build|check|run|clippy|fmt|install)\b|python(?:3)?\b|pytest\b|go\s+test\b|dotnet\s+(?:test|build|run|restore)\b|msbuild\b|make\b|cmake\b|(?:bash|sh)\b)/i;
const FORBIDDEN_COMMAND_RE = /\b(?:git|get-content|select-string|findstr|grep|rg|type|cat|dir|ls|find|where|which|head|tail|more)\b/i;
const TEST_RE = /^(?:(?:npm|pnpm|yarn)\s+(?:run\s+)?test\b|node\s+--test\b|npx\s+(?:jest|vitest)\b|pytest\b|python3?\s+-m\s+pytest\b|cargo\s+test\b|go\s+test\b|jest\b|vitest\b|dotnet\s+test\b|mvn\s+test\b)/i;
const EVIDENCE_TOOLS = new Set(['bash', 'shell', 'exec', 'read', 'write', 'edit', 'apply_patch']);
const SHELL_TOOLS = new Set(['bash', 'shell', 'exec', 'powershell', 'cmd', 'sh', 'run_command', 'terminal']);
const PREFERENCE_RE = /(?:\buse\s+.+?\s+(?:not|instead of|rather than)\s+.+|\balways\s+\w+|\bnever\s+\w+|\bdon'?t\s+use\b|\bdo\s+not\s+use\b)|دايماً|دائماً|أبداً|ابدا|لا\s+تست(?:خدم|عمل)|استخدم\s+.+\s+بدل/i;
const EXCLUDED_FILE_RE = /(?:^|\/)(?:AppData\/Local\/Temp|node_modules|target|\.git|\.jcode|\.cargo\/git\/checkouts)(?:\/|$)|\.(?:png|jpe?g|gif|webp|svg|log|tmp|zip|tar|gz|lock|exe|dll|pdf|bin)$/i;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function pickMeta(source) {
  const meta = {};
  if (!source || typeof source !== 'object') return meta;
  const keys = [
    'id', 'session_id', 'sessionId', 'parent_id', 'parentId', 'title',
    'created_at', 'createdAt', 'updated_at', 'updatedAt', 'working_dir',
    'workingDir', 'cwd', 'project', 'projectPath', 'model', 'provider_key',
    'short_name', 'shortName', 'status', 'last_active_at', 'is_debug', 'saved',
    'compaction', 'provider_session_id',
  ];
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) meta[key] = source[key];
  }
  return meta;
}

function mergeMeta(target, source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return target;
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value !== null) target[key] = value;
  }
  return target;
}

function normalizeBlock(block) {
  if (typeof block === 'string') return { type: 'text', text: block };
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  return block;
}

function normalizeMessage(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let role = typeof raw.role === 'string' ? raw.role : '';
  if (!role && typeof raw.type === 'string') role = raw.type;
  let content = raw.content;
  if (content === undefined && typeof raw.text === 'string') {
    content = [{ type: 'text', text: raw.text }];
  }
  if (typeof content === 'string') content = [{ type: 'text', text: content }];
  if (!Array.isArray(content)) content = content === undefined || content === null ? [] : [content];
  const blocks = content.map(normalizeBlock).filter(Boolean);
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    role: role || 'unknown',
    content: blocks,
    timestamp: typeof raw.timestamp === 'string' ? raw.timestamp : (typeof raw.ts === 'string' ? raw.ts : ''),
    display_role: typeof raw.display_role === 'string' ? raw.display_role : '',
  };
}

function blankDiagnostics(file, format) {
  return {
    file,
    basename: path.basename(file),
    format,
    exists: false,
    bytes: 0,
    lines: 0,
    malformed: 0,
    truncatedTail: false,
    pendingWrite: false,
    unknownBlocks: 0,
    error: null,
  };
}

function countUnknownBlocks(messages) {
  let unknown = 0;
  const known = new Set(['text', 'reasoning', 'tool_use', 'tool_result']);
  for (const message of messages) {
    for (const block of message.content) {
      if (typeof block.type === 'string' && !known.has(block.type)) unknown += 1;
    }
  }
  return unknown;
}

function parseSnapshotValue(value, diagnostics) {
  const root = asObject(value);
  if (!root) {
    diagnostics.error = 'snapshot root is not an object';
    return { meta: {}, messages: [] };
  }
  let meta = {};
  const nested = asObject(root.meta);
  if (nested) meta = mergeMeta(meta, nested);
  meta = mergeMeta(meta, pickMeta(root));

  let rawMessages = [];
  if (Array.isArray(root.messages)) rawMessages = root.messages;
  else if (Array.isArray(root.append_messages)) rawMessages = root.append_messages;
  else if (nested && Array.isArray(nested.messages)) rawMessages = nested.messages;

  const messages = rawMessages.map(normalizeMessage).filter(Boolean);
  return { meta, messages };
}

function parseJournalText(text, diagnostics) {
  const lines = text.split(/\r?\n/);
  const meta = {};
  const messages = [];
  let counted = 0;
  let malformed = 0;
  let lastObject = null;

  for (const line of lines) {
    if (!line || !line.trim()) continue;
    counted += 1;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    lastObject = parsed;
    if (Array.isArray(parsed)) {
      for (const message of parsed) {
        const normalized = normalizeMessage(message);
        if (normalized) messages.push(normalized);
      }
      continue;
    }
    const row = asObject(parsed);
    if (!row) {
      malformed += 1;
      continue;
    }
    mergeMeta(meta, row.meta);
    mergeMeta(meta, pickMeta(row));
    const appended = Array.isArray(row.append_messages)
      ? row.append_messages
      : (Array.isArray(row.messages) ? row.messages : []);
    for (const message of appended) {
      const normalized = normalizeMessage(message);
      if (normalized) messages.push(normalized);
    }
  }

  diagnostics.lines = counted;
  diagnostics.malformed = malformed;
  const truncatedTail = text.length > 0 && !text.endsWith('\n');
  diagnostics.truncatedTail = truncatedTail;
  diagnostics.pendingWrite = truncatedTail && malformed > 0;

  // A journal file whose last line is only metadata is normal; if the whole
  // file is one snapshot object, fall back to it.
  if (!messages.length && lastObject && asObject(lastObject) && Array.isArray(lastObject.messages)) {
    const snapshot = parseSnapshotValue(lastObject, diagnostics);
    return { meta: mergeMeta(meta, snapshot.meta), messages: snapshot.messages };
  }

  return { meta, messages };
}

/**
 * Parse one Jcode `.json` snapshot or `.journal.jsonl` file.
 * Never throws: unreadable or malformed input yields empty data plus diagnostics.
 */
export function parseJcodeSession(filePath) {
  const file = path.resolve(String(filePath ?? ''));
  const format = file.toLowerCase().endsWith('.jsonl') ? 'journal' : 'snapshot';
  const diagnostics = blankDiagnostics(file, format);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    diagnostics.error = error && error.code === 'ENOENT' ? 'file not found' : String(error && error.message);
    return { meta: {}, messages: [], diagnostics, prefix: '', file, basename: path.basename(file) };
  }
  if (!stat.isFile()) {
    diagnostics.error = 'not a regular file';
    return { meta: {}, messages: [], diagnostics, prefix: '', file, basename: path.basename(file) };
  }
  diagnostics.exists = true;
  diagnostics.bytes = stat.size;
  if (stat.size > MAX_FILE_BYTES) {
    diagnostics.error = `file is too large (${stat.size} bytes, limit ${MAX_FILE_BYTES})`;
    return { meta: {}, messages: [], diagnostics, prefix: '', file, basename: path.basename(file) };
  }

  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    diagnostics.error = String(error && error.message);
    return { meta: {}, messages: [], diagnostics, prefix: '', file, basename: path.basename(file) };
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  if (raw.length > MAX_MESSAGE_CHARS * 1000) raw = raw.slice(0, MAX_MESSAGE_CHARS * 1000);
  const prefix = Buffer.from(raw, 'utf8').subarray(0, 4096).toString('utf8');
  const basename = path.basename(file);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Not a single JSON document. A .json file may still be a journal (or a
    // journal may be cut mid-write), so try line-by-line before giving up.
    parsed = null;
  }

  let result;
  if (parsed !== null && !Array.isArray(parsed)) {
    const root = asObject(parsed);
    const isJournal = Boolean(root && Array.isArray(root.append_messages) && !Array.isArray(root.messages));
    if (isJournal || (format === 'journal' && root && root.meta)) {
      result = parseJournalText(raw, diagnostics);
    } else {
      result = parseSnapshotValue(parsed, diagnostics);
      diagnostics.lines = 1;
      diagnostics.truncatedTail = raw.length > 0 && !raw.endsWith('\n');
    }
  } else if (Array.isArray(parsed)) {
    // A bare array of messages is a tolerated snapshot variant.
    const messages = parsed.map(normalizeMessage).filter(Boolean);
    diagnostics.lines = messages.length;
    result = { meta: {}, messages };
  } else {
    result = parseJournalText(raw, diagnostics);
    if (format === 'snapshot') diagnostics.format = 'snapshot-as-jsonl';
  }

  diagnostics.unknownBlocks = countUnknownBlocks(result.messages);
  if (result.messages.length || result.meta.id || result.meta.title) {
    diagnostics.error = diagnostics.error || null;
  }
  return { ...result, diagnostics, prefix, file, basename };
}

function looksLikeSchemaText(text) {
  const sample = String(text ?? '');
  if (!sample.trim()) return true;
  if (SCHEMA_MARKER_RE.test(sample)) return true;
  if (TOOL_DOC_RE.test(sample)) return true;
  const braces = (sample.match(/[{}]/g) || []).length;
  if (braces > 2) return true;
  if (/\[\s*\{/.test(sample)) return true;
  return false;
}

function contentTexts(message, { maxChars = MAX_PROSE_CHARS, guard = true } = {}) {
  if (!message || !Array.isArray(message.content)) return [];
  const out = [];
  for (const block of message.content) {
    if (!block || typeof block !== 'object') continue;
    // Reasoning is deliberately ignored: it is speculative, not a decision.
    if (block.type && block.type !== 'text') continue;
    if (typeof block.text === 'string' && block.text.trim()) {
      // Tool documentation and pasted schemas are not session facts. Drop the
      // whole block rather than trying to split it into sentences.
      if (block.text.length > maxChars) continue;
      if (guard && looksLikeSchemaText(block.text)) continue;
      out.push(block.text);
    }
  }
  return out;
}

function stripSystemReminders(text) {
  return String(text ?? '')
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, ' ')
    .trim();
}

function isSubstantivePrompt(text) {
  const clean = stripSystemReminders(text);
  if (!clean) return false;
  if (clean.length > MAX_USER_PROMPT_CHARS) return false;
  if (looksLikeSchemaText(clean)) return false;
  if (/^new mcp tools are available\b/i.test(clean)) return false;
  if (/^# Session Context\b/i.test(clean)) return false;
  const meaningful = clean.replace(/[\s\p{P}\p{S}]+/gu, '');
  return meaningful.length >= 3;
}

function isAutoPrompt(text) {
  return /^\s*\[auto\]/i.test(String(text ?? ''));
}

function isInjectedPrompt(text) {
  const sample = String(text ?? '').trim();
  if (!sample) return true;
  if (isAutoPrompt(sample)) return true;
  if (/^\*\*(?:Background task stalled|Swarm|Subagent)\b/i.test(sample)) return true;
  if (/^(?:🐝\s*)?\*\*Swarm\b/i.test(sample)) return true;
  if (/^⚠\s*File activity:/i.test(sample)) return true;
  if (/^\[Attached image\b/i.test(sample)) return true;
  if (/^<system-reminder>/i.test(sample)) return true;
  return false;
}

function userPromptTexts(message) {
  if (!message || message.role !== 'user') return [];
  if (message.display_role === 'system') return [];
  const texts = contentTexts(message, { maxChars: MAX_USER_PROMPT_CHARS })
    .map(stripSystemReminders)
    .filter(isSubstantivePrompt);
  return texts;
}

function findRepoRoot(filePath) {
  let dir = path.dirname(path.resolve(String(filePath)));
  for (let depth = 0; depth < 40; depth += 1) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return toPosixPath(dir);
    } catch {
      return '';
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

function isExcludedFile(file) {
  const posix = toPosixPath(file).replace(/^\.\//, '');
  return EXCLUDED_FILE_RE.test(posix);
}

function hasAllowedExtension(file) {
  const match = String(file ?? '').match(/\.([A-Za-z0-9]+)$/);
  return Boolean(match && FILE_EXTENSIONS.includes(match[1].toLowerCase()));
}

function splitCommand(command) {
  const text = String(command ?? '');
  const parts = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === quote && text[i - 1] !== '\\') quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    const pair = text[i + 1] === ch && (ch === '&' || ch === '|');
    if (ch === '\n' || ch === ';' || pair) {
      if (current.trim()) parts.push(current.trim());
      current = '';
      if (pair) i += 1;
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function commandSegments(command) {
  return splitCommand(command)
    .map((part) => part.trim().replace(/^[$>]\s*/, ''))
    .filter((part) => part
      && STATE_COMMAND_RE.test(part)
      && !FORBIDDEN_COMMAND_RE.test(part)
      && !/^cd\b/i.test(part));
}

function resolveCandidatePath(raw, workingDir) {
  const value = String(raw ?? '').trim().replace(/^["']|["']$/g, '');
  if (!value) return null;
  const posix = toPosixPath(value);
  const absoluteRaw = /^[A-Za-z]:\//.test(posix) || posix.startsWith('/');
  const absolute = absoluteRaw
    ? posix
    : (workingDir ? toPosixPath(path.resolve(String(workingDir), posix)) : posix);
  const relative = absoluteRaw ? '' : posix.replace(/^\.\//, '').replace(/^\/+/, '');
  return { absolute, relative, absoluteRaw };
}

function isUnder(file, root) {
  const f = toPosixPath(file).toLowerCase().replace(/\/+$/, '');
  const r = toPosixPath(root).toLowerCase().replace(/\/+$/, '');
  return Boolean(r) && (f === r || f.startsWith(`${r}/`));
}

/**
 * Select at most 16 real source/doc files. Written/edited files win over read
 * files; only relative paths under an inferred project root (or the session
 * working directory) are kept, plus at most 6 edited files outside it.
 */
function finalizeFiles(candidates, workingDir) {
  if (!candidates.length) return [];
  const workingRoot = workingDir ? toPosixPath(path.resolve(String(workingDir))) : '';
  const rootCounts = new Map();
  const resolved = [];

  for (const candidate of candidates) {
    const info = resolveCandidatePath(candidate.raw, workingDir);
    if (!info) continue;
    const pathToCheck = info.relative || info.absolute;
    if (!hasAllowedExtension(pathToCheck) || isExcludedFile(pathToCheck)) continue;
    resolved.push({ ...candidate, ...info });
    if (info.absoluteRaw) {
      const root = findRepoRoot(info.absolute);
      if (root) rootCounts.set(root, (rootCounts.get(root) || 0) + 1);
    }
  }
  if (workingRoot) rootCounts.set(workingRoot, (rootCounts.get(workingRoot) || 0) + 1);

  let projectRoot = workingRoot;
  let bestCount = 0;
  for (const [root, count] of rootCounts) {
    if (count > bestCount || (count === bestCount && root.length > projectRoot.length)) {
      projectRoot = root;
      bestCount = count;
    }
  }

  const out = [];
  const seen = new Set();
  let outsideCount = 0;
  const ordered = [...resolved].sort((a, b) => b.priority - a.priority || a.order - b.order);
  for (const item of ordered) {
    let finalPath = item.relative;
    if (!finalPath) {
      if (projectRoot && isUnder(item.absolute, projectRoot)) {
        finalPath = toPosixPath(item.absolute).slice(toPosixPath(projectRoot).replace(/\/+$/, '').length + 1);
      } else {
        if (item.priority < 3) continue;
        if (outsideCount >= 6) continue;
        outsideCount += 1;
        finalPath = item.absolute;
      }
    }
    if (!finalPath || isExcludedFile(finalPath) || !hasAllowedExtension(finalPath)) continue;
    const key = finalPath.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(finalPath);
    if (out.length >= 16) break;
  }
  return out;
}

function sentencesOf(text) {
  const out = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
    if (!line) continue;
    for (const piece of line.split(/(?<=[.!?؟。])\s+/)) {
      const sentence = piece.trim();
      if (sentence.length >= 3) out.push(sentence);
    }
  }
  return out;
}

function addUnique(list, value, seen, max = MAX_ITEMS) {
  const clean = truncateChars(oneLine(value), MAX_TEXT);
  if (!clean) return;
  const key = looseKey(clean);
  if (!key || seen.has(key) || list.length >= max) return;
  seen.add(key);
  list.push(clean);
}

function looksLikeFile(value) {
  const text = String(value ?? '');
  const match = text.match(/\.([A-Za-z0-9]{1,12})$/);
  return Boolean(match && FILE_EXTENSIONS.includes(match[1].toLowerCase()));
}

function isPathLikeValue(value) {
  const text = String(value ?? '').trim();
  if (!text || text.includes('\n') || text.length > 400) return false;
  if (/^https?:\/\//i.test(text)) return false;
  return text.includes('/') || text.includes('\\') || /^[A-Za-z]:/.test(text) || looksLikeFile(text);
}

function collectInputFiles(input) {
  const out = [];
  if (!input || typeof input !== 'object') return out;
  for (const key of ['path', 'file_path', 'filePath', 'file', 'files', 'filename', 'target_file', 'notebook_path']) {
    const value = input[key];
    if (typeof value === 'string' && isPathLikeValue(value)) out.push(value.trim());
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && isPathLikeValue(item)) out.push(item.trim());
        else if (item && typeof item === 'object' && typeof item.path === 'string' && isPathLikeValue(item.path)) out.push(item.path);
      }
    }
  }
  return out;
}

function collectToolCalls(message) {
  const calls = [];
  if (!message || !Array.isArray(message.content)) return calls;
  for (const block of message.content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type !== 'tool_use') continue;
    const name = typeof block.name === 'string' ? block.name : (typeof block.tool === 'string' ? block.tool : 'tool');
    const input = asObject(block.input) || asObject(block.arguments) || {};
    calls.push({
      id: typeof block.id === 'string' ? block.id : (typeof block.tool_use_id === 'string' ? block.tool_use_id : ''),
      name,
      input,
    });
  }
  return calls;
}

function collectToolResults(message) {
  const results = [];
  if (!message || !Array.isArray(message.content)) return results;
  for (const block of message.content) {
    if (!block || typeof block !== 'object' || block.type !== 'tool_result') continue;
    let text = '';
    const content = block.content;
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content.map((part) => (typeof part === 'string' ? part : (part && typeof part.text === 'string' ? part.text : ''))).filter(Boolean).join(' ');
    } else if (content && typeof content === 'object' && typeof content.text === 'string') {
      text = content.text;
    }
    results.push({
      toolUseId: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
      content: text,
      isError: block.is_error === true || block.isError === true,
    });
  }
  return results;
}

function shellCommand(call) {
  if (!call) return '';
  const name = String(call.name || '').toLowerCase();
  const shortName = name.split(/[.:/\\]/).filter(Boolean).pop() || name;
  if (!SHELL_TOOLS.has(name) && !SHELL_TOOLS.has(shortName)) return '';
  const input = call.input || {};
  for (const key of ['command', 'cmd', 'script', 'code']) {
    if (typeof input[key] === 'string' && input[key].trim()) return input[key];
  }
  if (Array.isArray(input.command) && input.command.every((part) => typeof part === 'string')) {
    return input.command.join(' ');
  }
  return '';
}

/**
 * Extract a handoff skeleton from a parsed Jcode session.
 * @returns {{goal:string,constraints:string[],decisions:string[],filesTouched:string[],
 *   commands:Array, tests:string[], openQuestions:string[], nextSteps:string[],
 *   blockers:string[], userPrompts:string[], summary:string}}
 */
export function extractSessionFacts(parsed) {
  const messages = Array.isArray(parsed && parsed.messages) ? parsed.messages : [];
  const meta = (parsed && parsed.meta) || {};
  const workingDir = meta.working_dir || meta.workingDir || meta.cwd || '';

  const constraints = [];
  const decisions = [];
  const commands = [];
  const tests = [];
  const openQuestions = [];
  const nextSteps = [];
  const blockers = [];
  const userPrompts = [];
  const fileCandidates = [];
  let fileOrder = 0;

  const seen = {
    constraints: new Set(),
    decisions: new Set(),
    commands: new Set(),
    tests: new Set(),
    openQuestions: new Set(),
    nextSteps: new Set(),
    blockers: new Set(),
    prompts: new Set(),
  };

  const pending = new Map();
  let goalPrompt = '';
  let latestNonAutoPrompt = '';

  for (const message of messages) {
    const prompts = userPromptTexts(message);
    for (const prompt of prompts) {
      const clean = oneLine(prompt);
      if (!isSubstantivePrompt(clean)) continue;
      if (userPrompts.length < MAX_PROMPTS) {
        const key = looseKey(clean);
        if (key && !seen.prompts.has(key)) {
          seen.prompts.add(key);
          userPrompts.push(truncateChars(clean, 600));
        }
      }
      if (!isInjectedPrompt(clean)) {
        if (!goalPrompt) goalPrompt = clean;
        latestNonAutoPrompt = clean;
      }
    }

    // User prompts contribute constraints only (plus goal/preferences).
    // Decisions, next steps, blockers and questions come from assistant text.
    // Reasoning blocks never reach contentTexts(); tool results are not prose.
    const userProse = prompts.filter((prompt) => !isInjectedPrompt(prompt));
    const assistantProse = message.role === 'assistant' ? contentTexts(message) : [];

    for (const text of userProse) {
      for (const sentence of sentencesOf(text)) {
        if (CONSTRAINT_RE.test(sentence)) addUnique(constraints, sentence, seen.constraints, MAX_ITEMS);
      }
    }

    for (const text of assistantProse) {
      for (const sentence of sentencesOf(text)) {
        if (sentence.length <= 320 && DECISION_RE.test(sentence)) {
          addUnique(decisions, sentence, seen.decisions, MAX_DECISIONS);
        }
        if (NEXT_RE.test(sentence)) addUnique(nextSteps, sentence, seen.nextSteps, MAX_NEXT_STEPS);
        if (BLOCKER_RE.test(sentence)) addUnique(blockers, sentence, seen.blockers, MAX_BLOCKERS);
        if (QUESTION_RE.test(sentence) || /[?؟]\s*$/.test(sentence)) {
          addUnique(openQuestions, sentence, seen.openQuestions, MAX_NEXT_STEPS);
        }
      }
    }

    for (const text of [...userProse, ...assistantProse]) {
      for (const sentence of sentencesOf(text)) {
        for (const match of sentence.match(FILE_RE) || []) {
          if (match.length > 300 || match.includes('://')) continue;
          if (!looksLikeFile(match)) continue;
          fileCandidates.push({ raw: match, priority: 0, order: fileOrder });
          fileOrder += 1;
        }
      }
      for (const line of String(text).split(/\r?\n/)) {
        for (const segment of commandSegments(line)) {
          const command = truncateChars(oneLine(segment), 200);
          if (!command) continue;
          const key = looseKey(command);
          if (seen.commands.has(key)) continue;
          seen.commands.add(key);
          commands.push({ command, tool: 'text', result: '', status: 'unknown' });
        }
      }
    }

    for (const call of collectToolCalls(message)) {
      const name = String(call.name || '').toLowerCase();
      const shortName = name.split(/[.:/\\]/).filter(Boolean).pop() || name;
      const evidenceTool = EVIDENCE_TOOLS.has(name) || EVIDENCE_TOOLS.has(shortName)
        || SHELL_TOOLS.has(name) || SHELL_TOOLS.has(shortName);
      if (evidenceTool) {
        const priority = ['write', 'edit', 'apply_patch'].includes(shortName) ? 3
          : (shortName === 'read' ? 2 : 1);
        for (const value of collectInputFiles(call.input)) {
          fileCandidates.push({ raw: value, priority, order: fileOrder });
          fileOrder += 1;
        }
      }
      const command = shellCommand(call);
      if (!command) continue;
      for (const segment of commandSegments(command)) {
        const clean = truncateChars(oneLine(segment), 200);
        if (!clean) continue;
        const key = looseKey(clean);
        if (seen.commands.has(key)) continue;
        seen.commands.add(key);
        const entry = { command: clean, tool: call.name, result: '', status: 'unknown' };
        commands.push(entry);
        if (call.id) pending.set(call.id, entry);
      }
    }

    for (const result of collectToolResults(message)) {
      const entry = result.toolUseId ? pending.get(result.toolUseId) : null;
      const text = truncateChars(oneLine(result.content), 300);
      if (entry) {
        entry.result = text;
        entry.status = commandStatus(text, result.isError);
      }
    }
  }

  for (const entry of commands) {
    if (!TEST_RE.test(entry.command)) continue;
    addUnique(tests, entry.command, seen.tests);
  }

  const goal = goalPrompt ? truncateChars(goalPrompt, 600) : '';
  const goalKey = looseKey(goal).slice(0, 40);
  const filteredDecisions = [];
  for (const decision of decisions) {
    const key = looseKey(decision);
    if (goalKey && (key.includes(goalKey) || goalKey.includes(key.slice(0, 40)))) continue;
    filteredDecisions.push(decision);
    if (filteredDecisions.length >= MAX_DECISIONS) break;
  }
  const objectiveSource = latestNonAutoPrompt;
  const objectiveNow = objectiveSource && objectiveSource !== goal
    ? truncateChars(objectiveSource, 600)
    : '';
  const summary = objectiveNow;
  const filesTouched = finalizeFiles(fileCandidates, workingDir);

  const facts = {
    goal,
    objectiveNow,
    constraints: constraints.slice(0, MAX_ITEMS),
    decisions: filteredDecisions,
    filesTouched,
    commands: commands.slice(0, 6),
    tests: tests.slice(0, MAX_ITEMS),
    openQuestions: openQuestions.slice(0, MAX_ITEMS),
    nextSteps: nextSteps.slice(0, MAX_NEXT_STEPS),
    blockers: blockers.slice(0, MAX_BLOCKERS),
    userPrompts,
    summary,
  };
  return deepRedact(facts);
}

/** Preference statements a user actually wrote, never assistant prose. */
export function extractUserPreferences(parsed) {
  const messages = Array.isArray(parsed && parsed.messages) ? parsed.messages : [];
  const out = [];
  const seen = new Set();
  for (const message of messages) {
    for (const prompt of userPromptTexts(message)) {
      if (isInjectedPrompt(prompt)) continue;
      for (const sentence of sentencesOf(prompt)) {
        if (!PREFERENCE_RE.test(sentence)) continue;
        const clean = oneLine(sentence);
        if (!clean || clean.length < 5 || clean.length > MAX_TEXT) continue;
        if (looksLikeSchemaText(clean)) continue;
        const key = looseKey(clean);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(clean);
        if (out.length >= MAX_PREFERENCES) return deepRedact(out);
      }
    }
  }
  return deepRedact(out);
}

/**
 * Stable session identity: the session id when present, otherwise a hash of
 * the first 4KB plus the file basename.
 */
export function sessionFingerprint(parsed) {
  const meta = (parsed && parsed.meta) || {};
  const id = meta.id || meta.session_id || meta.sessionId;
  if (typeof id === 'string' && id.trim()) {
    return `sid:${id.trim().replace(/[^\w@.:-]+/g, '_').slice(0, 180)}`;
  }
  const hash = crypto.createHash('sha256')
    .update(String((parsed && parsed.prefix) || ''))
    .update('\u0000')
    .update(String((parsed && parsed.basename) || ''))
    .digest('hex')
    .slice(0, 24);
  return `sha:${hash}`;
}

export { FILE_EXTENSIONS, isSubstantivePrompt };
