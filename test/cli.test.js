import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { makeHarness, runCli } from './helpers.js';

test('--help and --version work', async () => {
  const h = makeHarness();
  const help = await runCli(['--help'], h);
  assert.equal(help.code, 0);
  assert.match(help.out, /USAGE/);
  assert.match(help.out, /checkpoint/);
  assert.match(help.out, /RECALL_HOME/);

  const version = await runCli(['--version'], h);
  assert.equal(version.code, 0);
  assert.match(version.out, /^\d+\.\d+\.\d+/);
});

test('remember reads text from stdin', async () => {
  const h = makeHarness();
  const result = await runCli(['remember', '--stdin', '--kind', 'fact'], h, {
    stdin: 'piped fact about windows paths C:\\work\\app\n',
  });
  assert.equal(result.code, 0);
  assert.match(result.out, /^remembered r/);

  const list = await runCli(['list', '--json'], h);
  const record = JSON.parse(list.out).records[0];
  assert.equal(record.text, 'piped fact about windows paths C:\\work\\app');
});

test('remember refuses obvious secrets unless --force', async () => {
  const h = makeHarness();
  const refused = await runCli(['remember', 'api_key=sk-abcdefghijklmnopqrstuvwx'], h);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /likely secret/);

  const forced = await runCli(['remember', 'token=abcdefghijklmnop', '--force'], h);
  assert.equal(forced.code, 0);
  assert.match(forced.out, /^remembered /);
});

test('unknown command is a usage error', async () => {
  const h = makeHarness();
  const result = await runCli(['frobnicate'], h);
  assert.equal(result.code, 2);
  assert.match(result.err, /unknown command/);
});

test('export produces markdown and json', async () => {
  const h = makeHarness();
  await runCli(['remember', 'exported fact', '--kind', 'fact'], h);

  const md = await runCli(['export', '--format', 'md'], h);
  assert.equal(md.code, 0);
  assert.match(md.out, /# recall export/);
  assert.match(md.out, /exported fact/);

  const json = await runCli(['export', '--format', 'json'], h);
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.out);
  assert.equal(parsed.schema, 'jcode-recall/export@1');
  assert.equal(parsed.count, 1);
  assert.equal(parsed.records[0].text, 'exported fact');
});

test('export --out writes a file inside the workspace only when asked', async () => {
  const h = makeHarness();
  await runCli(['remember', 'file export fact'], h);
  const target = path.join(h.root, 'out.md');
  const result = await runCli(['export', '--format', 'md', '--out', target], h);
  assert.equal(result.code, 0);
  assert.match(result.out, /exported 1 record/);
});

test('stats and doctor run cleanly', async () => {
  const h = makeHarness();
  await runCli(['remember', 'stats fact'], h);

  const stats = await runCli(['stats', '--json'], h);
  assert.equal(stats.code, 0);
  const summary = JSON.parse(stats.out);
  assert.equal(summary.summary.total, 1);

  const doctor = await runCli(['doctor'], h);
  assert.equal(doctor.code, 0);
  assert.match(doctor.out, /All checks passed/);
  assert.match(doctor.out, /zero-dependency/);
});

test('hooks: stop is silent, pre-compact acks with an id, session-start briefs', async () => {
  const h = makeHarness();
  const stop = await runCli(['hook', 'stop'], h);
  assert.equal(stop.code, 0);
  assert.equal(stop.out, '');

  const compact = await runCli(['hook', 'pre-compact'], h, {
    stdin: JSON.stringify([
      { role: 'user', content: 'Goal: fix the flaky test' },
      { role: 'assistant', content: 'We decided to wait for the socket instead of sleeping.' },
    ]),
  });
  assert.equal(compact.code, 0);
  assert.match(compact.out, /^recall: checkpoint r[a-z0-9]+ saved/);

  const start = await runCli(['hook', 'session-start'], h);
  assert.equal(start.code, 0);
  assert.match(start.out, /recall briefing/);
  assert.match(start.out, /fix the flaky test/);
});

test('pre-compact accepts a Claude-style transcript_path payload', async () => {
  const fs = await import('node:fs');
  const h = makeHarness();
  const transcript = path.join(h.root, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    JSON.stringify({ role: 'user', content: 'Goal: wire the MCP server' }),
    JSON.stringify({ role: 'assistant', content: 'Decision: use newline-delimited JSON.' }),
  ].join('\n'), 'utf8');

  const result = await runCli(['hook', 'pre-compact'], h, {
    stdin: JSON.stringify({ hook_event_name: 'PreCompact', transcript_path: transcript }),
  });
  assert.equal(result.code, 0);
  assert.match(result.out, /checkpoint .* saved/);
  assert.match(result.out, /wire the MCP server/);
});

test('checkpoint text is searchable like any other memory', async () => {
  const h = makeHarness();
  await runCli(['checkpoint', '--goal', 'migrate the billing tables', '--decision', 'use online DDL'], h);
  const result = await runCli(['search', 'online DDL billing'], h);
  assert.equal(result.code, 0);
  assert.match(result.out, /migrate the billing tables/);
});
