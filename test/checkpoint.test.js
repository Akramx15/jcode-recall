import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeHarness, runCli } from './helpers.js';
import { extractHandoff, parseMessagesInput } from '../src/checkpoint.js';

const TRANSCRIPT = [
  { role: 'user', content: 'Goal: ship the login fix' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'We decided to use argon2 instead of bcrypt for hashing.' },
      { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
    ],
  },
  {
    role: 'user',
    content: [{ type: 'tool_result', content: '5 passing, 0 failing', is_error: false }],
  },
  {
    role: 'assistant',
    content: 'Next step: update the docs at src/auth/README.md. Open question: do we need a migration?',
  },
];

function jsonl(messages) {
  return `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`;
}

test('extractHandoff mines goals, decisions, commands, files and questions', () => {
  const { data, stats } = extractHandoff(jsonl(TRANSCRIPT), { project: 'demo' });
  assert.equal(data.goal, 'ship the login fix');
  assert.ok(data.decisions.some((d) => d.includes('argon2')));
  assert.deepEqual(data.commands.map((c) => c.command), ['npm test']);
  assert.equal(data.commands[0].status, 'ok');
  assert.ok(data.files.some((f) => f.endsWith('src/auth/README.md')));
  assert.ok(data.nextSteps.some((step) => step.includes('update the docs')), 'next step detected');
  assert.ok(data.openQuestions.some((q) => q.includes('migration')), 'open question detected');
  assert.equal(stats.messages, 4);
  assert.ok(stats.toolCalls >= 1);
});

test('extraction never invents text outside the transcript', () => {
  const raw = jsonl(TRANSCRIPT);
  const { data } = extractHandoff(raw);
  const haystack = raw.replace(/\\n/g, '\n');
  for (const decision of data.decisions) assert.ok(haystack.includes(decision.slice(0, 20)));
  for (const step of data.nextSteps) assert.ok(haystack.includes(step.slice(0, 20)));
  assert.equal(data.summary, '');
});

test('unknown transcript shapes are tolerated', () => {
  const weird = JSON.stringify({
    conversation: { turns: [{ message: { role: 'user', content: 'Goal: keep it simple' } }] },
    extra: 42,
  });
  const parsed = parseMessagesInput(weird);
  assert.equal(parsed.messages.length, 1);
  const { data } = extractHandoff(weird);
  assert.equal(data.goal, 'keep it simple');

  assert.doesNotThrow(() => extractHandoff('not json at all'));
  assert.doesNotThrow(() => extractHandoff(''));
});

test('checkpoint from a messages file round-trips through resume', async () => {
  const h = makeHarness();
  const messagesPath = path.join(h.root, 'session.jsonl');
  fs.writeFileSync(messagesPath, jsonl(TRANSCRIPT), 'utf8');

  const saved = await runCli(['checkpoint', '--messages', messagesPath, '--json'], h);
  assert.equal(saved.code, 0, saved.err);
  const parsed = JSON.parse(saved.out);
  assert.match(parsed.id, /^r/);
  assert.equal(parsed.data.goal, 'ship the login fix');
  assert.equal(parsed.stats.messages, 4);

  const resumed = await runCli(['resume'], h);
  assert.equal(resumed.code, 0);
  assert.match(resumed.out, /Latest checkpoint/);
  assert.match(resumed.out, /ship the login fix/);
  assert.match(resumed.out, /unverified/);
});

test('checkpoint from flags fills every requested section', async () => {
  const h = makeHarness();
  const result = await runCli([
    'checkpoint',
    '--goal', 'stabilize the importer',
    '--constraint', 'no new dependencies',
    '--decision', 'stream CSV rows instead of loading them',
    '--file', 'src/importer/csv.js',
    '--command', 'node --test',
    '--test', 'node --test test/importer.test.js',
    '--open-question', 'what about quoted newlines?',
    '--next', 'add a fixture for 10k rows',
    '--blocker', 'fixture download is blocked',
    '--summary', 'Importer rewritten to stream.',
    '--json',
  ], h);

  assert.equal(result.code, 0, result.err);
  const parsed = JSON.parse(result.out);
  assert.equal(parsed.data.constraints[0], 'no new dependencies');
  assert.ok(parsed.data.decisions.includes('stream CSV rows instead of loading them'));
  assert.deepEqual(parsed.data.files, ['src/importer/csv.js']);
  assert.deepEqual(parsed.data.commands.map((c) => c.command), ['node --test', 'node --test test/importer.test.js']);
  assert.equal(parsed.data.nextSteps[0], 'add a fixture for 10k rows');
  assert.equal(parsed.data.blockers[0], 'fixture download is blocked');
  assert.equal(parsed.data.summary, 'Importer rewritten to stream.');
});

test('checkpoint input from stdin and summary file work', async () => {
  const h = makeHarness();
  const summaryPath = path.join(h.root, 'summary.md');
  fs.writeFileSync(summaryPath, 'Halfway through the migration; schema is stable.\n', 'utf8');

  const stdinResult = await runCli(['checkpoint', '--goal', 'finish migration', '--json'], h, {
    stdin: JSON.stringify({ goal: 'ignored because flag wins' }),
  });
  assert.equal(stdinResult.code, 0);
  assert.equal(JSON.parse(stdinResult.out).data.goal, 'finish migration');

  const withSummary = await runCli(['checkpoint', '--goal', 'finish migration', '--summary-file', summaryPath, '--json'], h);
  assert.equal(withSummary.code, 0);
  assert.match(JSON.parse(withSummary.out).data.summary, /schema is stable/);
});

test('checkpoint refuses empty input', async () => {
  const h = makeHarness();
  const result = await runCli(['checkpoint'], h);
  assert.equal(result.code, 2);
  assert.match(result.err, /nothing to checkpoint/);
});

test('secrets in a transcript are redacted before storage', async () => {
  const h = makeHarness();
  const raw = jsonl([
    { role: 'user', content: 'Goal: rotate credentials' },
    { role: 'assistant', content: 'The key is sk-abcdefghijklmnopqrstuvwx and it must be rotated.' },
  ]);
  const result = await runCli(['checkpoint', '--json'], h, { stdin: raw });
  assert.equal(result.code, 0);
  const parsed = JSON.parse(result.out);
  const serialized = JSON.stringify(parsed);
  assert.doesNotMatch(serialized, /sk-abcdefghijklmnopqrstuvwx/);
  assert.match(serialized, /redacted/);
});
