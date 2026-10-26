// Deterministic checkpoint extraction.
//
// This module never invents facts. Every string it emits is a substring of the
// input (whitespace-collapsed and length-capped), or a count of observed
// messages/tool calls. Unknown input shapes are tolerated and skipped.

import { oneLine, safeJsonParse, truncateChars } from './util.js';
import { looseKey } from './text.js';

const MAX_ITEMS = 12;
const MAX_TEXT = 240;

const GOAL_RE = /^(?:goal|objective|task|الهدف|المهمة)\s*[:：-]\s*(.+)$/i;
const CONSTRAINT_RE = /\b(?:must|must not|never|always|do not|don't|avoid|only use|required|constraint|not allowed)\b|يجب|لا يجب|ممنوع|قيود|شرط/i;
const DECISION_RE = /\b(?:decided|decision|we chose|chose|switched to|going with|will use|instead of|opted for)\b|قرر|قررنا|اخترنا|سنستخدم|بدلاً من|بدلا من/i;
const NEXT_RE = /\b(?:next step|next steps|next,|then |after that|todo|remaining|follow[- ]?up|pending|still need)\b|الخطوة التالية|التالي|بعد ذلك|المتبقي|ما زال/i;
const BLOCKER_RE = /\b(?:blocked|blocker|cannot proceed|can't proceed|not working|broken|error:|fails? because)\b|عائق|محظور|لا يعمل|خطأ|فشل/i;
const QUESTION_RE = /\b(?:open question|unclear|not sure|need to confirm|which approach|should we)\b|غير واضح|سؤال|هل /i;
const PATH_RE = /(?:[A-Za-z]:[\\/][^\s"'`<>|]+|(?:\.{1,2}[\\/])?(?:[\w@.+-]+[\\/])+[\w@.+-]+\.[A-Za-z0-9]{1,8})/g;

function contentToString(value, depth = 0) {
  if (depth > 4) return '';
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map((v) => contentToString(v, depth + 1)).filter(Boolean).join(' ');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.content !== 'undefined') return contentToString(value.content, depth + 1);
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return '';
}

/** Pull message-like objects out of any reasonable transcript shape. */
export function collectMessages(root) {
  const out = [];
  const seen = new Set();

  const visit = (node, depth) => {
    if (depth > 8 || node === null || node === undefined) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    // Transcript envelope: {type: 'assistant', message: {role, content}}
    if (node.message && typeof node.message === 'object' && !Array.isArray(node.message)) {
      const inner = node.message;
      if (typeof inner.role === 'string' || inner.content !== undefined) {
        out.push({
          role: typeof inner.role === 'string' ? inner.role : (typeof node.type === 'string' ? node.type : 'unknown'),
          content: inner.content,
        });
        return;
      }
    }

    // Direct message row: {role, content} or {role, text}
    if (typeof node.role === 'string' && (node.content !== undefined || typeof node.text === 'string')) {
      out.push(node);
      return;
    }

    // Standalone tool events
    if (node.type === 'tool_use' || node.type === 'tool_result') {
      out.push({ role: 'tool', content: [node] });
      return;
    }

    for (const key of ['messages', 'transcript', 'conversation', 'history', 'turns', 'items', 'entries', 'events']) {
      if (node[key] !== undefined && node[key] !== node) visit(node[key], depth + 1);
    }
  };

  visit(root, 0);
  return out;
}

/** Turn raw stdin into messages, tolerating JSON, JSONL, or prose. */
export function parseMessagesInput(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '').trim();
  if (!text) return { messages: [], transcriptPath: null, parsedJson: false };

  const whole = safeJsonParse(text);
  if (whole.ok) {
    return {
      messages: collectMessages(whole.value),
      transcriptPath: findTranscriptPath(whole.value),
      parsedJson: true,
    };
  }

  const messages = [];
  let parsedJson = false;
  let transcriptPath = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
    const parsed = safeJsonParse(trimmed);
    if (!parsed.ok) continue;
    parsedJson = true;
    messages.push(...collectMessages(parsed.value));
    if (!transcriptPath) transcriptPath = findTranscriptPath(parsed.value);
  }
  return { messages, transcriptPath, parsedJson };
}

function findTranscriptPath(value) {
  if (!value || typeof value !== 'object') return null;
  const keys = ['transcript_path', 'transcriptPath', 'transcript', 'messages_path', 'messagesPath'];
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim() && !candidate.includes('\n')) return candidate.trim();
  }
  return null;
}

/** Flatten messages into text/tool observations, preserving order. */
export function flattenMessages(messages) {
  const items = [];

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = typeof message.role === 'string' ? message.role : 'unknown';
    const texts = [];
    const toolCalls = [];
    const toolResults = [];

    const walk = (content, depth) => {
      if (depth > 6 || content === undefined || content === null) return;
      if (typeof content === 'string') {
        if (content.trim()) texts.push(content);
        return;
      }
      if (Array.isArray(content)) {
        for (const part of content) walk(part, depth + 1);
        return;
      }
      if (typeof content !== 'object') return;

      if (typeof content.text === 'string' && content.text.trim()) texts.push(content.text);
      if (typeof content.thinking === 'string' && content.thinking.trim()) texts.push(content.thinking);

      if (content.type === 'tool_use' || (content.name && (content.input || content.arguments))) {
        const input = content.input !== undefined ? content.input : (content.arguments !== undefined ? content.arguments : {});
        toolCalls.push({ name: String(content.name || content.tool || 'tool'), input: input && typeof input === 'object' ? input : {} });
      }
      if (content.type === 'tool_result') {
        toolResults.push({
          content: contentToString(content.content),
          isError: content.is_error === true || content.isError === true,
        });
      }
      if (typeof content.command === 'string' && content.command.trim()) {
        toolCalls.push({ name: 'shell', input: { command: content.command } });
      }
      if (content.content !== undefined) walk(content.content, depth + 1);
      if (content.output !== undefined) walk(content.output, depth + 1);
    };

    walk(message.content, 0);
    if (!texts.length && typeof message.text === 'string') texts.push(message.text);

    for (const call of message.tool_calls || message.toolCalls || []) {
      if (call && typeof call === 'object') {
        const fn = call.function && typeof call.function === 'object' ? call.function : call;
        let input = fn.arguments !== undefined ? fn.arguments : fn.input;
        if (typeof input === 'string') {
          const parsed = safeJsonParse(input);
          input = parsed.ok && parsed.value && typeof parsed.value === 'object' ? parsed.value : { raw: input };
        }
        toolCalls.push({ name: String(fn.name || 'tool'), input: input && typeof input === 'object' ? input : {} });
      }
    }

    items.push({ role, texts, toolCalls, toolResults });
  }

  return items;
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

function addUnique(list, value, seen) {
  const clean = truncateChars(oneLine(value), MAX_TEXT);
  if (!clean) return;
  const key = looseKey(clean);
  if (!key || seen.has(key)) return;
  if (list.length >= MAX_ITEMS) return;
  seen.add(key);
  list.push(clean);
}

function commandStatus(result, isError) {
  if (isError) return 'fail';
  const text = oneLine(result).toLowerCase();
  if (!text) return 'unknown';
  const nonzeroFail = /\b([1-9]\d*) (?:failed|failing|errors?|failures?)\b/.test(text);
  const zeroFail = /\b0 (?:failed|failing|errors?|failures?)\b/.test(text);
  if (zeroFail && !nonzeroFail) return 'ok';
  if (/\b(?:exit code 0|passed|passing|all tests? pass|success|succeeded|✓)\b/.test(text) && !nonzeroFail) return 'ok';
  if (nonzeroFail || /\b(?:exit code [1-9]\d*|failed|failure|traceback|error:|not ok|✗)\b/.test(text)) return 'fail';
  return 'unknown';
}

function extractPaths(text, into, seen) {
  const matches = String(text ?? '').match(PATH_RE) || [];
  for (const match of matches) {
    if (match.length > 300) continue;
    if (/^https?:/i.test(match)) continue;
    const normalized = match.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalized || normalized.includes('://')) continue;
    addUnique(into, normalized, seen);
  }
}

function inputPaths(input) {
  const keys = ['file_path', 'filePath', 'path', 'file', 'filename', 'target_file', 'notebook_path'];
  const out = [];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) out.push(value.trim());
  }
  return out;
}

function isCommandTool(call) {
  return Boolean(call && call.input && typeof call.input.command === 'string' && call.input.command.trim());
}

/**
 * Extract a handoff skeleton from raw transcript text.
 * @returns {{data: object, stats: object, transcriptPath: string|null}}
 */
export function extractHandoff(raw, { project = null } = {}) {
  const parsed = parseMessagesInput(raw);
  const messages = parsed.messages;
  const items = flattenMessages(messages);

  const fileSeen = new Set();
  const data = {
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
  const seen = {
    constraints: new Set(),
    decisions: new Set(),
    openQuestions: new Set(),
    nextSteps: new Set(),
    blockers: new Set(),
  };

  const pendingCommands = [];
  const commandSeen = new Set();
  let toolCallCount = 0;

  for (const item of items) {
    for (const sentence of item.texts.flatMap(sentencesOf)) {
      const goalMatch = GOAL_RE.exec(sentence);
      if (goalMatch && !data.goal) data.goal = truncateChars(oneLine(goalMatch[1]), MAX_TEXT);

      if (CONSTRAINT_RE.test(sentence)) addUnique(data.constraints, sentence, seen.constraints);
      if (DECISION_RE.test(sentence)) addUnique(data.decisions, sentence, seen.decisions);
      if (NEXT_RE.test(sentence)) addUnique(data.nextSteps, sentence, seen.nextSteps);
      if (BLOCKER_RE.test(sentence)) addUnique(data.blockers, sentence, seen.blockers);
      if (QUESTION_RE.test(sentence) || /[?؟]\s*$/.test(sentence)) {
        addUnique(data.openQuestions, sentence, seen.openQuestions);
      }
      extractPaths(sentence, data.files, fileSeen);
    }

    for (const call of item.toolCalls) {
      toolCallCount += 1;
      for (const p of inputPaths(call.input)) {
        addUnique(data.files, p.replace(/\\/g, '/'), fileSeen);
      }
      if (isCommandTool(call)) {
        const command = truncateChars(oneLine(call.input.command), 200);
        if (!command) continue;
        const key = looseKey(command);
        if (commandSeen.has(key)) continue;
        commandSeen.add(key);
        pendingCommands.push({ command, name: call.name });
      }
    }

    for (const result of item.toolResults) {
      const command = pendingCommands.shift();
      const text = truncateChars(oneLine(result.content), 300);
      if (command) {
        data.commands.push({
          command: command.command,
          tool: command.name,
          result: text,
          status: commandStatus(text, result.isError),
        });
      } else if (text) {
        data.commands.push({ command: '(tool)', tool: 'tool', result: text, status: commandStatus(text, result.isError) });
      }
    }

    if (!data.goal && item.role === 'user') {
      const first = item.texts.flatMap(sentencesOf)[0];
      if (first) data.goal = truncateChars(first, MAX_TEXT);
    }
  }

  // Any unmatched commands still count as observed activity.
  for (const command of pendingCommands) {
    data.commands.push({ command: command.command, tool: command.name, result: '', status: 'unknown' });
  }

  data.commands = data.commands.slice(0, MAX_ITEMS);
  data.files = data.files.slice(0, 32);

  return {
    data,
    stats: {
      messages: items.length,
      toolCalls: toolCallCount,
      project,
      parsedJson: parsed.parsedJson,
    },
    transcriptPath: parsed.transcriptPath,
  };
}

/** Merge explicit flags over extracted data. Flags always win when non-empty. */
export function mergeHandoff(extracted, explicit = {}) {
  const data = { ...extracted };
  for (const key of ['constraints', 'decisions', 'files', 'openQuestions', 'nextSteps', 'blockers']) {
    const values = Array.isArray(explicit[key]) ? explicit[key].filter(Boolean) : [];
    if (values.length) data[key] = [...values, ...data[key].filter((v) => !values.some((x) => looseKey(x) === looseKey(v)))].slice(0, MAX_ITEMS);
  }
  if (explicit.goal) data.goal = truncateChars(oneLine(explicit.goal), MAX_TEXT);
  if (explicit.summary) data.summary = String(explicit.summary).trim().slice(0, 4000);
  if (Array.isArray(explicit.commands) && explicit.commands.length) {
    const provided = explicit.commands.map((command) => ({
      command: truncateChars(oneLine(command), 200),
      tool: 'flag',
      result: '',
      status: 'unknown',
    }));
    data.commands = [...provided, ...data.commands].slice(0, MAX_ITEMS);
  }
  return data;
}

function stringArray(value) {
  if (value === undefined || value === null || value === true || value === false) return [];
  const raw = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) out.push(item.trim());
    else if (item && typeof item === 'object' && typeof item.command === 'string' && item.command.trim()) out.push(item.command.trim());
  }
  return out;
}

/**
 * Accept snake_case, camelCase, or loose aliases from a handoff JSON object.
 * Only known keys are read; everything else is ignored.
 */
export function normalizeHandoffObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const pick = (...keys) => {
    for (const key of keys) {
      if (obj[key] !== undefined && obj[key] !== null) return obj[key];
    }
    return undefined;
  };
  return {
    goal: typeof pick('goal', 'objective', 'task') === 'string' ? String(pick('goal', 'objective', 'task')).trim() : '',
    summary: typeof pick('summary', 'overview') === 'string' ? String(pick('summary', 'overview')).trim() : '',
    constraints: stringArray(pick('constraints', 'requirements')),
    decisions: stringArray(pick('decisions', 'choices')),
    files: stringArray(pick('files_touched', 'filesTouched', 'files', 'artifacts')),
    commands: stringArray(pick('commands', 'tests', 'commands_run', 'commandsRun')),
    openQuestions: stringArray(pick('open_questions', 'openQuestions', 'questions')),
    nextSteps: stringArray(pick('next_steps', 'nextSteps', 'next')),
    blockers: stringArray(pick('blockers', 'blocked')),
  };
}

/** Compact plain-text body stored as the record's searchable text. */
export function checkpointText(data, { project = null, stats = null } = {}) {
  const lines = [];
  if (project) lines.push(`Project: ${project}`);
  if (data.goal) lines.push(`Goal: ${data.goal}`);
  if (data.constraints.length) lines.push(`Constraints: ${data.constraints.join(' | ')}`);
  if (data.decisions.length) lines.push(`Decisions: ${data.decisions.join(' | ')}`);
  if (data.files.length) lines.push(`Files touched: ${data.files.join(' | ')}`);
  if (data.commands.length) {
    const rendered = data.commands.map((c) => `${c.command}${c.status ? ` [${c.status}]` : ''}${c.result ? ` -> ${truncateChars(c.result, 160)}` : ''}`);
    lines.push(`Commands: ${rendered.join(' | ')}`);
  }
  if (data.openQuestions.length) lines.push(`Open questions: ${data.openQuestions.join(' | ')}`);
  if (data.nextSteps.length) lines.push(`Next steps: ${data.nextSteps.join(' | ')}`);
  if (data.blockers.length) lines.push(`Blockers: ${data.blockers.join(' | ')}`);
  if (data.summary) lines.push(`Summary: ${data.summary}`);
  if (stats) lines.push(`Observed: ${stats.messages || 0} messages, ${stats.toolCalls || 0} tool calls`);
  if (!lines.length) lines.push('Session handoff (no structured fields extracted)');
  return lines.join('\n');
}

export function hasSignal(data) {
  return Boolean(
    data
    && (data.goal || data.summary
      || data.constraints.length || data.decisions.length || data.files.length
      || data.commands.length || data.openQuestions.length || data.nextSteps.length || data.blockers.length),
  );
}
