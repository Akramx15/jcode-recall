import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeHarness } from './helpers.js';
import {
  extractSessionFacts,
  extractUserPreferences,
  parseJcodeSession,
  sessionFingerprint,
} from '../src/session.js';

function journalLine(meta, messages) {
  return JSON.stringify({ meta, append_messages: messages });
}

function writeJournal(file, lines, { bom = false, crlf = false } = {}) {
  const eol = crlf ? '\r\n' : '\n';
  fs.writeFileSync(file, `${bom ? '\uFEFF' : ''}${lines.join(eol)}${eol}`, 'utf8');
}

const ARABIC_PROMPT = 'أريد إصلاح تسجيل الدخول في src/auth/login.js';
const NEXT_PROMPT = 'Next, update src/auth/session.js and docs/README.md.';

function syntheticJournal(file) {
  const meta = {
    id: 'session_owl_1793000000000_aaaabbbbccccdddd',
    title: 'Arabic auth session',
    working_dir: 'C:/work/auth-app',
    short_name: 'owl',
    updated_at: '2026-10-26T10:00:00.000Z',
  };
  const lines = [
    journalLine(meta, [
      {
        id: 'm-system',
        role: 'user',
        display_role: 'system',
        content: [{ type: 'text', text: '<system-reminder>\n# Session Context\nWorking directory: C:/work/auth-app\n</system-reminder>' }],
        timestamp: '2026-10-26T10:00:00.000Z',
      },
      { id: 'm-user-1', role: 'user', content: [{ type: 'text', text: ARABIC_PROMPT }], timestamp: '2026-10-26T10:00:01.000Z' },
    ]),
    journalLine(meta, [
      {
        id: 'm-reasoning',
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'We decided to use reasoning-only-wrong because it is private.' }],
        timestamp: '2026-10-26T10:00:02.000Z',
      },
    ]),
    journalLine(meta, [
      {
        id: 'm-assistant',
        role: 'assistant',
        content: [
          { type: 'text', text: 'قررنا أن نستخدم argon2 بدلاً من bcrypt لأن الأداء أهم.' },
          { type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'npm test' } },
        ],
        timestamp: '2026-10-26T10:00:03.000Z',
      },
    ]),
    '{"truncated": this line is not json',
    journalLine(meta, [
      {
        id: 'm-tool-result',
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-1', content: '1 failing, 0 passing', is_error: true }],
        timestamp: '2026-10-26T10:00:04.000Z',
      },
      { id: 'm-user-2', role: 'user', content: [{ type: 'text', text: NEXT_PROMPT }], timestamp: '2026-10-26T10:00:05.000Z' },
    ]),
    journalLine(meta, [
      {
        id: 'm-next',
        role: 'assistant',
        content: [{ type: 'text', text: 'Next step: update src/auth/session.js and docs/README.md.' }],
        timestamp: '2026-10-26T10:00:06.000Z',
      },
    ]),
    journalLine({ ...meta, status: 'Closed' }, []),
  ];
  writeJournal(file, lines, { bom: true, crlf: true });
  return meta;
}

test('parseJcodeSession reads a BOM/CRLF journal and skips malformed lines', () => {
  const h = makeHarness();
  const file = path.join(h.root, 'session_owl_1793000000000_aaaabbbbccccdddd.journal.jsonl');
  const meta = syntheticJournal(file);

  const parsed = parseJcodeSession(file);
  assert.equal(parsed.meta.id, meta.id);
  assert.equal(parsed.meta.working_dir, 'C:/work/auth-app');
  assert.equal(parsed.meta.status, 'Closed');
  assert.equal(parsed.messages.length, 7);
  assert.equal(parsed.diagnostics.format, 'journal');
  assert.equal(parsed.diagnostics.malformed, 1);
  assert.equal(parsed.diagnostics.pendingWrite, false);
  assert.equal(parsed.messages[0].role, 'user');
  assert.equal(parsed.messages[1].display_role, '');
});

test('parseJcodeSession accepts a top-level snapshot and counts unknown blocks', () => {
  const h = makeHarness();
  const file = path.join(h.root, 'session_cat_1_abcd.json');
  fs.writeFileSync(file, JSON.stringify({
    id: 'session_cat_1_abcd',
    title: 'snapshot title',
    working_dir: 'C:/work/snap',
    messages: [
      { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Fix the parser' }] },
      {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'We decided to use imaginary-thought because it is private.' },
          { type: 'text', text: 'We will use safe parsing because inputs are hostile.' },
          { type: 'tool_use', id: 't1', name: 'write_file', input: { file_path: 'src/parse.js' } },
          { type: 'image', source: 'unused' },
        ],
      },
    ],
  }), 'utf8');

  const parsed = parseJcodeSession(file);
  assert.equal(parsed.meta.id, 'session_cat_1_abcd');
  assert.equal(parsed.meta.title, 'snapshot title');
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.diagnostics.unknownBlocks, 1);
  assert.equal(parsed.diagnostics.error, null);
});

test('extractSessionFacts finds the goal, Arabic decisions, files, commands and tests', () => {
  const h = makeHarness();
  const file = path.join(h.root, 'session_owl_1793000000000_aaaabbbbccccdddd.journal.jsonl');
  syntheticJournal(file);
  const parsed = parseJcodeSession(file);
  const facts = extractSessionFacts(parsed);

  assert.equal(facts.goal, ARABIC_PROMPT);
  assert.equal(facts.summary, NEXT_PROMPT);
  assert.ok(facts.decisions.some((text) => text.includes('argon2')));
  assert.ok(facts.decisions.some((text) => text.includes('بدلاً من bcrypt')));
  assert.ok(!facts.decisions.some((text) => text.includes('reasoning-only-wrong')), 'reasoning must be ignored');
  assert.ok(facts.filesTouched.includes('src/auth/login.js'));
  assert.ok(facts.filesTouched.includes('src/auth/session.js'));
  assert.ok(facts.filesTouched.includes('docs/README.md'));
  assert.deepEqual(facts.commands.map((entry) => entry.command), ['npm test']);
  assert.equal(facts.commands[0].status, 'fail');
  assert.deepEqual(facts.tests, ['npm test']);
  assert.ok(facts.nextSteps.some((text) => text.includes('update src/auth/session.js')));
  assert.equal(facts.userPrompts.length, 2);
});

test('extraction never invents text outside the transcript', () => {
  const h = makeHarness();
  const file = path.join(h.root, 'session_owl_1793000000000_aaaabbbbccccdddd.journal.jsonl');
  syntheticJournal(file);
  const raw = fs.readFileSync(file, 'utf8');
  const facts = extractSessionFacts(parseJcodeSession(file));

  for (const decision of facts.decisions) {
    assert.ok(raw.includes(decision.slice(0, 24)), `decision not in transcript: ${decision}`);
  }
  for (const step of facts.nextSteps) {
    assert.ok(raw.includes(step.slice(0, 24)), `next step not in transcript: ${step}`);
  }
  assert.ok(raw.includes(facts.goal));
});

test('parseJcodeSession tolerates a truncated journal write and never throws', () => {
  const h = makeHarness();
  const file = path.join(h.root, 'session_cut_1_abcd.journal.jsonl');
  fs.writeFileSync(file, [
    journalLine({ id: 'session_cut_1_abcd', working_dir: 'C:/work/x' }, [
      { id: 'u1', role: 'user', content: [{ type: 'text', text: 'Keep going' }] },
    ]),
    '{"meta":{"id":"session_cut_1_abcd"},"append_messages":[{"id":"u2"',
  ].join('\n'), 'utf8');

  const parsed = parseJcodeSession(file);
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.diagnostics.malformed, 1);
  assert.equal(parsed.diagnostics.truncatedTail, true);
  assert.equal(parsed.diagnostics.pendingWrite, true);

  assert.doesNotThrow(() => parseJcodeSession(path.join(h.root, 'missing.json')));
  const missing = parseJcodeSession(path.join(h.root, 'missing.json'));
  assert.equal(missing.messages.length, 0);
  assert.equal(missing.diagnostics.exists, false);
  assert.match(missing.diagnostics.error, /not found/);
});

test('sessionFingerprint prefers the session id and separates same basenames', () => {
  const h = makeHarness();
  const dirA = path.join(h.root, 'a');
  const dirB = path.join(h.root, 'b');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  const fileA = path.join(dirA, 'session_shared.json');
  const fileB = path.join(dirB, 'session_shared.json');
  fs.writeFileSync(fileA, JSON.stringify({ id: 'session_one', messages: [] }), 'utf8');
  fs.writeFileSync(fileB, JSON.stringify({ id: 'session_two', messages: [] }), 'utf8');

  const a = parseJcodeSession(fileA);
  const b = parseJcodeSession(fileB);
  assert.equal(sessionFingerprint(a), 'sid:session_one');
  assert.equal(sessionFingerprint(b), 'sid:session_two');
  assert.notEqual(sessionFingerprint(a), sessionFingerprint(b));

  const anonymous = parseJcodeSession(fileA);
  delete anonymous.meta.id;
  assert.match(sessionFingerprint(anonymous), /^sha:[a-f0-9]{24}$/);
});

test('extractUserPreferences only reads explicit user preference statements', () => {
  const parsed = {
    meta: { working_dir: 'C:/work/app' },
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Always use pnpm not npm in this repo.' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Never use sudo for builds.' }] },
      { role: 'user', content: [{ type: 'text', text: 'لا تستخدم yarn هنا.' }] },
    ],
  };
  const preferences = extractUserPreferences(parsed);
  assert.equal(preferences.length, 2);
  assert.ok(preferences[0].includes('pnpm'));
  assert.ok(preferences.some((text) => text.includes('لا تستخدم')));
  assert.ok(!preferences.some((text) => text.includes('sudo')), 'assistant prose is not a preference');
});

test('MCP tool schemas never become decisions, blockers, files or preferences', () => {
  const schema = JSON.stringify({
    type: 'object',
    description: 'Use for: code review, second opinions. External effects are blocked and recorded.',
    properties: {
      input_schema: { type: 'object' },
      file_path: { type: 'string', description: 'Defaults to 1280x720, click target pending.' },
    },
    required: ['input_schema'],
  });
  const parsed = {
    meta: { id: 'session_schema_1_aaa', working_dir: 'C:/work/rtl' },
    messages: [
      {
        id: 'user-goal',
        role: 'user',
        content: [{ type: 'text', text: 'Fix RTL caret/click/selection in src/app.rs. always use pnpm, never npm' }],
      },
      {
        id: 'assistant-schema',
        role: 'assistant',
        content: [
          { type: 'text', text: schema },
          {
            type: 'tool_use',
            id: 'mcp-1',
            name: 'mcp__opencode__ask',
            input: { description: schema, file_path: 'C:/schema/generated.js' },
          },
          { type: 'tool_use', id: 'bash-1', name: 'bash', input: { command: 'npm test' } },
        ],
      },
      {
        id: 'tool-result',
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'mcp-1', content: schema }],
      },
    ],
  };

  const facts = extractSessionFacts(parsed);
  const preferences = extractUserPreferences(parsed);
  assert.equal(facts.goal, 'Fix RTL caret/click/selection in src/app.rs. always use pnpm, never npm');
  assert.equal(preferences.length, 1);
  assert.match(preferences[0], /pnpm/);
  assert.equal(facts.decisions.length, 0, 'schema prose is not a decision');
  assert.ok(!facts.blockers.some((text) => /"type"|type":|blocked and recorded/i.test(text)));
  assert.ok(!facts.filesTouched.some((file) => file.includes('schema/generated.js')));
  assert.deepEqual(facts.commands.map((entry) => entry.command), ['npm test']);
  assert.ok(!facts.nextSteps.some((step) => /click target|request pending/i.test(step)));
});

test('the goal is never duplicated as a decision', () => {
  const parsed = {
    meta: { working_dir: 'C:/work/rtl' },
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'استخدم الوكلاء وأصلح مشكلة RTL في src/app.rs' }],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'We decided to use argon2 instead of bcrypt because security requires it.' }],
      },
    ],
  };
  const facts = extractSessionFacts(parsed);
  assert.match(facts.goal, /الوكلاء/);
  assert.equal(facts.decisions.length, 1);
  assert.match(facts.decisions[0], /argon2/);
  assert.ok(!facts.decisions[0].includes(facts.goal.slice(0, 20)));
});

test('[auto] prompts never become goal, constraints or preferences', () => {
  const parsed = {
    meta: { working_dir: 'C:/work/rtl' },
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: '[auto] Do not reply or wait for the user. Use swarms.' }],
      },
      {
        role: 'user',
        content: [{ type: 'text', text: 'Fix the caret click mapping in src/app.rs. Always use pnpm.' }],
      },
    ],
  };
  const facts = extractSessionFacts(parsed);
  const preferences = extractUserPreferences(parsed);
  assert.match(facts.goal, /Fix the caret/);
  assert.ok(!facts.constraints.some((text) => text.includes('Do not reply')));
  assert.equal(preferences.length, 1);
  assert.ok(!preferences.some((text) => text.includes('Do not reply')));
  assert.equal(facts.objectiveNow, '');
});

test('temp, screenshot and cache paths are excluded from files', () => {
  const parsed = {
    meta: { working_dir: 'C:/Users/A/jcode-rtl/jcode-desktop-main' },
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'w1', name: 'write', input: { file_path: 'C:/Users/A/AppData/Local/Temp/rtl-tests-block.txt' } },
          { type: 'tool_use', id: 'w2', name: 'edit', input: { file_path: 'C:/Users/A/jcode-rtl/work/rtl-after-release.png' } },
          { type: 'tool_use', id: 'w3', name: 'edit', input: { file_path: 'C:/Users/A/.jcode/prompt-overlay.md' } },
          { type: 'tool_use', id: 'w4', name: 'edit', input: { file_path: 'C:/Users/A/jcode-rtl/jcode-desktop-main/crates/app.rs' } },
        ],
      },
    ],
  };
  const facts = extractSessionFacts(parsed);
  assert.deepEqual(facts.filesTouched, ['crates/app.rs']);
});

test('written files beat read files and the file list is capped', () => {
  const readFiles = Array.from({ length: 18 }, (_, index) => `crates/read-${index}.rs`);
  const parsed = {
    meta: { working_dir: 'C:/work/repo' },
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'r1', name: 'read', input: { files: readFiles } },
          { type: 'tool_use', id: 'e1', name: 'edit', input: { file_path: 'crates/edited.rs' } },
        ],
      },
    ],
  };
  const facts = extractSessionFacts(parsed);
  assert.equal(facts.filesTouched.length, 16);
  assert.equal(facts.filesTouched[0], 'crates/edited.rs');
  assert.ok(facts.filesTouched.includes('crates/edited.rs'));
});

test('listing-only shell commands are excluded and state commands are kept', () => {
  const parsed = {
    meta: { working_dir: 'C:/work/repo' },
    messages: [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'b1',
            name: 'bash',
            input: { command: 'cd /d C:\\Users\\A && dir /b\nnpm test\ngit status -sb' },
          },
        ],
      },
    ],
  };
  const facts = extractSessionFacts(parsed);
  assert.deepEqual(facts.commands.map((entry) => entry.command), ['npm test']);
  assert.deepEqual(facts.tests, ['npm test']);
});
