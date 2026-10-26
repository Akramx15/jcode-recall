import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeHarness, runCli } from './helpers.js';

function makeRepo(h, ...segments) {
  const dir = path.join(h.root, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('resume falls back to the most recent project when cwd has no memory', async () => {
  const h = makeHarness();
  const alpha = makeRepo(h, 'repos', 'alpha');
  const beta = makeRepo(h, 'repos', 'beta');

  await runCli(['remember', 'Alpha uses argon2 for password hashing', '--kind', 'decision'], { ...h, cwd: alpha });
  const result = await runCli(['resume', '--budget', '3000'], { ...h, cwd: beta });

  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /No memory for beta; showing the most recent project alpha/);
  assert.match(result.out, /Alpha uses argon2/);
  assert.match(result.out, /@.*repos[\\/]alpha/);
  assert.match(result.out, /Pass --project to choose/);
});

test('the resume fallback never mixes two other projects', async () => {
  const h = makeHarness();
  const alpha = makeRepo(h, 'repos', 'alpha');
  const gamma = makeRepo(h, 'repos', 'gamma');
  const beta = makeRepo(h, 'repos', 'beta');

  await runCli(['remember', 'Alpha record is the old one', '--kind', 'decision'], { ...h, cwd: alpha });
  const later = new Date(Date.now() + 60000);
  await runCli(['remember', 'Gamma record is the newest one', '--kind', 'decision'], { ...h, cwd: gamma, now: later });

  const result = await runCli(['resume', '--budget', '3000'], { ...h, cwd: beta });
  assert.match(result.out, /showing the most recent project gamma/);
  assert.match(result.out, /Gamma record is the newest one/);
  assert.doesNotMatch(result.out, /Alpha record is the old one/);
});

test('an explicit --project does not fall back', async () => {
  const h = makeHarness();
  const alpha = makeRepo(h, 'repos', 'alpha');
  const beta = makeRepo(h, 'repos', 'beta');
  await runCli(['remember', 'Alpha only record', '--kind', 'decision'], { ...h, cwd: alpha });

  const result = await runCli(['resume', '--project', 'beta', '--budget', '2000'], { ...h, cwd: beta });
  assert.equal(result.code, 0, result.err);
  assert.doesNotMatch(result.out, /showing the most recent project/);
  assert.doesNotMatch(result.out, /Alpha only record/);
  assert.match(result.out, /No memories for this project yet/);
});

test('resume --all is unchanged and never falls back', async () => {
  const h = makeHarness();
  const alpha = makeRepo(h, 'repos', 'alpha');
  const beta = makeRepo(h, 'repos', 'beta');
  await runCli(['remember', 'Alpha record visible with --all', '--kind', 'decision'], { ...h, cwd: alpha });

  const result = await runCli(['resume', '--all', '--budget', '2000'], { ...h, cwd: beta });
  assert.equal(result.code, 0, result.err);
  assert.doesNotMatch(result.out, /No memory for/);
  assert.match(result.out, /Alpha record visible with --all/);
});

test('resume does not fall back when the current project has visible records', async () => {
  const h = makeHarness();
  const alpha = makeRepo(h, 'repos', 'alpha');
  const beta = makeRepo(h, 'repos', 'beta');
  await runCli(['remember', 'Alpha newer record', '--kind', 'decision'], {
    ...h,
    cwd: alpha,
    now: new Date(Date.now() + 60000),
  });
  await runCli(['remember', 'Beta has its own record', '--kind', 'decision'], { ...h, cwd: beta });

  const result = await runCli(['resume', '--budget', '2000'], { ...h, cwd: beta });
  assert.match(result.out, /Beta has its own record/);
  assert.doesNotMatch(result.out, /showing the most recent project/);
  assert.doesNotMatch(result.out, /Alpha newer record/);
});
