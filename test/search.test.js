import test from 'node:test';
import assert from 'node:assert/strict';

import { makeHarness, runCli, tokens } from './helpers.js';

async function seed(h, entries) {
  for (const entry of entries) {
    const args = ['remember', entry.text, '--kind', entry.kind || 'fact'];
    if (entry.tags) for (const tag of entry.tags) args.push('--tag', tag);
    if (entry.files) for (const file of entry.files) args.push('--file', file);
    if (entry.importance) args.push('--importance', String(entry.importance));
    const result = await runCli(args, h);
    assert.equal(result.code, 0, result.err);
  }
}

test('BM25 ranks the specific record above a generic one', async () => {
  const h = makeHarness();
  await seed(h, [
    { text: 'The queue uses SQLite WAL mode for crash safety', tags: ['database', 'queue'] },
    { text: 'Queue processing happens in a background worker', tags: ['queue'] },
    { text: 'Unrelated styling conventions for buttons', tags: ['ui'] },
  ]);

  const result = await runCli(['search', 'sqlite wal crash'], h);
  assert.equal(result.code, 0);
  const blocks = result.out.split(/\n(?=\d+\. )/).filter((block) => /^\d+\. /.test(block));
  assert.ok(blocks.length >= 1, 'search output contains a numbered hit');
  assert.match(blocks[0], /fact/, 'headline carries the kind');
  assert.match(blocks[0], /SQLite WAL/, 'specific hit ranks first');
  assert.ok(!result.out.includes('background worker'), 'non-matching record is not returned');
});

test('Arabic queries match normalized Arabic text', async () => {
  const h = makeHarness();
  await seed(h, [
    { text: 'نستخدم قاعدة بيانات SQLite للتخزين المحلي', tags: ['بيانات'] },
    { text: 'تصميم واجهة المستخدم بالألوان الداكنة', tags: ['واجهة'] },
  ]);

  // Query with a different alef/ta-marbuta form than the stored text.
  const result = await runCli(['search', 'قاعده بيانات'], h);
  assert.equal(result.code, 0);
  assert.match(result.out, /SQLite/);
  assert.doesNotMatch(result.out, /واجهة المستخدم/);

  const diacritics = await runCli(['search', 'قَاعِدَة'], h);
  assert.match(diacritics.out, /SQLite/);
});

test('literal mode does exact normalized substrings', async () => {
  const h = makeHarness();
  await seed(h, [
    { text: 'Deploy with docker compose up' },
    { text: 'Docker images are cached in CI' },
  ]);

  const result = await runCli(['search', 'docker compose', '--literal'], h);
  assert.equal(result.code, 0);
  assert.match(result.out, /docker compose up/);
  assert.doesNotMatch(result.out, /cached in CI/);
});

test('tag, file and kind filters narrow results', async () => {
  const h = makeHarness();
  await seed(h, [
    { text: 'queue retry policy is exponential', kind: 'decision', tags: ['queue'], files: ['src/worker/retry.js'] },
    { text: 'queue payload schema uses zod', kind: 'fact', tags: ['schema'], files: ['src/worker/schema.js'] },
  ]);

  const byTag = await runCli(['search', 'queue', '--tag', 'schema'], h);
  assert.match(byTag.out, /zod/);
  assert.doesNotMatch(byTag.out, /exponential/);

  const byFile = await runCli(['search', 'queue', '--file', 'retry.js'], h);
  assert.match(byFile.out, /exponential/);
  assert.doesNotMatch(byFile.out, /zod/);

  const byKind = await runCli(['search', 'queue', '--kind', 'decision'], h);
  assert.match(byKind.out, /exponential/);
  assert.doesNotMatch(byKind.out, /zod/);
});

test('pinned records beat equally relevant unpinned records', async () => {
  const h = makeHarness();
  await seed(h, [{ text: 'build command is make build', tags: ['build'] }]);
  const second = await runCli(['remember', 'build command is make release', '--tag', 'build', '--json'], h);
  const pinnedId = JSON.parse(second.out).id;
  await runCli(['pin', pinnedId], h);

  const result = await runCli(['search', 'build command make'], h);
  const releaseIndex = result.out.indexOf('make release');
  const buildIndex = result.out.indexOf('make build');
  assert.ok(releaseIndex !== -1 && buildIndex !== -1);
  assert.ok(releaseIndex < buildIndex, 'pinned record ranks first');
});

test('search output never exceeds the token budget', async () => {
  const h = makeHarness();
  const long = 'The deployment pipeline uses a blue green strategy with health checks and rollback. '.repeat(12);
  for (let i = 0; i < 8; i += 1) {
    await runCli(['remember', `${long} variant ${i}`, '--tag', 'deploy'], h);
  }

  for (const budget of [8, 20, 40, 80, 200]) {
    const result = await runCli(['search', 'deployment pipeline rollback', '--budget', String(budget)], h);
    assert.equal(result.code, 0);
    assert.ok(tokens(result.out) <= budget, `budget ${budget} exceeded: ${tokens(result.out)} tokens`);
  }
});

test('brief survives tiny budgets and keeps the wrapper', async () => {
  const h = makeHarness();
  await seed(h, [
    { text: 'The worker retries failed jobs three times', tags: ['worker'] },
  ]);

  const normal = await runCli(['brief', 'add retry logic to the worker', '--budget', '600'], h);
  assert.equal(normal.code, 0);
  assert.match(normal.out, /^<recall-context>/);
  assert.match(normal.out, /<\/recall-context>/);
  assert.match(normal.out, /retries failed jobs/);
  assert.ok(tokens(normal.out) <= 600);

  const tiny = await runCli(['brief', 'add retry logic to the worker', '--budget', '60'], h);
  assert.equal(tiny.code, 0);
  assert.ok(tokens(tiny.out) <= 60, `tiny brief exceeded budget: ${tokens(tiny.out)}`);
});

test('search --json returns scores and provenance', async () => {
  const h = makeHarness();
  await runCli(['remember', 'searchable json fact about queues', '--tag', 'queue'], h);
  const result = await runCli(['search', 'queues', '--json'], h);
  const parsed = JSON.parse(result.out);
  assert.equal(parsed.returned, 1);
  assert.equal(parsed.hits.length, 1);
  assert.ok(parsed.hits[0].score > 0);
  assert.equal(parsed.hits[0].project, 'repo');
  assert.ok(parsed.hits[0].projectPath);
  assert.ok(parsed.hits[0].projectKey);
});

test('empty query is a usage error', async () => {
  const h = makeHarness();
  const result = await runCli(['search', '   '], h);
  assert.equal(result.code, 2);
  assert.match(result.err, /query/);
});
