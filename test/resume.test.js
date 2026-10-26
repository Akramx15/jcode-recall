import test from 'node:test';
import assert from 'node:assert/strict';

import { FIXED_NOW, makeHarness, runCli, tokens } from './helpers.js';

test('resume includes pinned facts and the latest checkpoint', async () => {
  const h = makeHarness();
  const pinned = JSON.parse((await runCli([
    'remember',
    'The production database is read-only for agents',
    '--kind', 'fact',
    '--importance', '5',
    '--json',
  ], h)).out);
  await runCli(['pin', pinned.id], h);

  await runCli(['remember', 'Prefer tabs over spaces in Go files', '--kind', 'preference'], h);
  await runCli(['remember', 'Chose Postgres 16 for the new service', '--kind', 'decision'], h);
  await runCli(['checkpoint', '--goal', 'ship billing', '--decision', 'use stripe webhooks', '--next', 'write integration test'], h);

  const result = await runCli(['resume', '--budget', '3000'], h);
  assert.equal(result.code, 0);
  assert.match(result.out, /Pinned/);
  assert.match(result.out, /read-only for agents/);
  assert.match(result.out, /Latest checkpoint/);
  assert.match(result.out, /ship billing/);
  assert.match(result.out, /unverified/);
  assert.match(result.out, /stripe webhooks/);
  assert.match(result.out, /write integration test/);
  assert.match(result.out, /Postgres 16/);
  assert.ok(tokens(result.out) <= 3000);
});

test('resume marks an old checkpoint as stale', async () => {
  const h = makeHarness();
  await runCli(['checkpoint', '--goal', 'stale goal check'], h);

  const tenDaysLater = new Date(FIXED_NOW.getTime() + 10 * 86400000);
  const result = await runCli(['resume'], h, { now: tenDaysLater });
  assert.equal(result.code, 0);
  assert.match(result.out, /stale/);
  assert.match(result.out, /unverified/);
});

test('resume marks global records as global', async () => {
  const h = makeHarness();
  await runCli(['remember', 'Never force-push to main in this org', '--kind', 'preference', '--global', '--importance', '5'], h);
  const result = await runCli(['resume', '--budget', '2000'], h);
  assert.equal(result.code, 0);
  assert.match(result.out, /Never force-push/);
  assert.match(result.out, /global/);
});

test('resume is scoped to the current project key', async () => {
  const h = makeHarness();
  const a = `${h.root}/a/app`;
  const b = `${h.root}/b/app`;
  const fs = await import('node:fs');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });

  await runCli(['remember', 'alpha-only pinned truth', '--kind', 'fact'], { ...h, cwd: a });
  await runCli(['remember', 'beta-only pinned truth', '--kind', 'fact'], { ...h, cwd: b });

  const fromA = await runCli(['resume'], { ...h, cwd: a });
  assert.match(fromA.out, /alpha-only/);
  assert.doesNotMatch(fromA.out, /beta-only/);

  const both = await runCli(['resume', '--project', 'app', '--all'], { ...h, cwd: a });
  assert.equal(both.code, 0);
});

test('resume respects the token budget even with many records', async () => {
  const h = makeHarness();
  for (let i = 0; i < 30; i += 1) {
    await runCli(['remember', `Fact number ${i}: ${'detail '.repeat(20)}`, '--importance', String((i % 5) + 1)], h);
  }
  for (const budget of [80, 200, 600]) {
    const result = await runCli(['resume', '--budget', String(budget)], h);
    assert.equal(result.code, 0);
    assert.ok(tokens(result.out) <= budget, `resume budget ${budget} exceeded: ${tokens(result.out)}`);
  }
});

test('resume with no data prints a helpful hint', async () => {
  const h = makeHarness();
  const result = await runCli(['resume'], h);
  assert.equal(result.code, 0);
  assert.match(result.out, /No memories for this project yet/);
});
