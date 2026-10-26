import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  dataFiles,
  makeHarness,
  makeProject,
  projectDataFile,
  readLines,
  runCli,
} from './helpers.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'recall.js');

test('remember, list and dedupe', async () => {
  const h = makeHarness();
  const first = await runCli(['remember', 'The queue uses SQLite WAL mode', '--kind', 'decision', '--tag', 'db', '--importance', '4'], h);
  assert.equal(first.code, 0);
  assert.match(first.out, /^remembered r/);

  const list = await runCli(['list', '--json'], h);
  assert.equal(list.code, 0);
  const parsed = JSON.parse(list.out);
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.records[0].kind, 'decision');
  assert.equal(parsed.records[0].importance, 4);
  assert.deepEqual(parsed.records[0].tags, ['db']);
  assert.ok(parsed.records[0].projectKey, 'record must carry a canonical projectKey');
  assert.ok(parsed.records[0].projectPath, 'record must carry a projectPath');

  const again = await runCli(['remember', '  The queue uses SQLite WAL mode  '], h);
  assert.match(again.out, /^duplicate /);
  assert.equal(readLines(projectDataFile(h.home)).length, 1, 'dedupe must not append a second line');
});

test('malformed JSONL lines are skipped, not fatal', async () => {
  const h = makeHarness();
  await runCli(['remember', 'survivor fact'], h);
  const file = projectDataFile(h.home);
  fs.appendFileSync(file, '\n{not json at all}\n{"id":"only-id"}\n', 'utf8');

  const list = await runCli(['list', '--json'], h);
  assert.equal(list.code, 0);
  assert.equal(JSON.parse(list.out).records.length, 1);

  const doctor = await runCli(['doctor', '--json'], h);
  assert.equal(doctor.code, 0);
  const report = JSON.parse(doctor.out);
  const check = report.checks.find((c) => c.name === 'data files parse');
  assert.ok(check, 'doctor reports parse status');
  assert.match(check.detail, /malformed/);
});

test('same basename in two directories stays isolated (canonical key)', async () => {
  const h = makeHarness();
  const a = makeProject(h.root, 'a', 'app');
  const b = makeProject(h.root, 'b', 'app');

  const ra = await runCli(['remember', 'widget alpha configuration'], { ...h, cwd: a });
  const rb = await runCli(['remember', 'widget beta configuration'], { ...h, cwd: b });
  assert.equal(ra.code, 0);
  assert.equal(rb.code, 0);
  assert.equal(dataFiles(h.home).filter((f) => !f.endsWith('global.jsonl')).length, 2, 'each repo gets its own file');

  const fromA = await runCli(['search', 'widget'], { ...h, cwd: a });
  assert.equal(fromA.code, 0);
  assert.match(fromA.out, /alpha/);
  assert.doesNotMatch(fromA.out, /beta/, 'search from repo A must not see repo B');

  const fromB = await runCli(['search', 'widget'], { ...h, cwd: b });
  assert.match(fromB.out, /beta/);
  assert.doesNotMatch(fromB.out, /alpha/);

  const both = await runCli(['search', 'widget', '--project', 'app'], { ...h, cwd: a });
  assert.equal(both.code, 0);
  assert.match(both.out, /alpha/);
  assert.match(both.out, /beta/);
  assert.match(both.out, /a\/app/, 'explicit label search must show provenance paths');
  assert.match(both.out, /b\/app/);

  const listA = await runCli(['list', '--json'], { ...h, cwd: a });
  const parsed = JSON.parse(listA.out);
  assert.equal(parsed.records.length, 1);
  assert.match(parsed.records[0].projectPath, /a\/app$/);
});

test('identical text in two different projects is not deduplicated', async () => {
  const h = makeHarness();
  const a = makeProject(h.root, 'one', 'shared');
  const b = makeProject(h.root, 'two', 'shared');
  const text = 'identical text across unrelated repos';

  assert.match((await runCli(['remember', text], { ...h, cwd: a })).out, /^remembered /);
  assert.match((await runCli(['remember', text], { ...h, cwd: b })).out, /^remembered /);

  const files = dataFiles(h.home).filter((f) => !f.endsWith('global.jsonl'));
  assert.equal(files.length, 2);
  for (const file of files) assert.equal(readLines(file).length, 1);
});

test('forget appends a tombstone and hides the record', async () => {
  const h = makeHarness();
  const created = await runCli(['remember', 'temporary fact', '--json'], h);
  const id = JSON.parse(created.out).id;
  const before = readLines(projectDataFile(h.home)).length;

  const forgot = await runCli(['forget', id], h);
  assert.equal(forgot.code, 0);
  assert.match(forgot.out, /forgot/);
  assert.equal(readLines(projectDataFile(h.home)).length, before + 1, 'append-only tombstone');

  const list = await runCli(['list', '--json'], h);
  assert.equal(JSON.parse(list.out).records.length, 0);
});

test('pin and unpin survive re-reads', async () => {
  const h = makeHarness();
  const created = await runCli(['remember', 'pinned fact', '--json'], h);
  const id = JSON.parse(created.out).id;

  await runCli(['pin', id], h);
  let list = JSON.parse((await runCli(['list', '--json'], h)).out);
  assert.equal(list.records[0].pinned, true);

  await runCli(['unpin', id], h);
  list = JSON.parse((await runCli(['list', '--json'], h)).out);
  assert.equal(list.records[0].pinned, false);
});

test('supersedes hides the replaced preference by default', async () => {
  const h = makeHarness();
  const old = await runCli(['remember', 'Use moment.js for dates', '--kind', 'preference', '--json'], h);
  const oldId = JSON.parse(old.out).id;
  const replacement = await runCli(['remember', 'Use Temporal API for dates', '--kind', 'preference', '--supersedes', oldId], h);
  assert.equal(replacement.code, 0);
  assert.match(replacement.out, /^remembered /);

  const list = await runCli(['list', '--json'], h);
  const ids = JSON.parse(list.out).records.map((r) => r.id);
  assert.ok(ids.length >= 1);
  assert.ok(!ids.includes(oldId), 'superseded record is hidden');

  const withSuperseded = await runCli(['list', '--json', '--include-superseded'], h);
  const all = JSON.parse(withSuperseded.out).records;
  const replaced = all.find((r) => r.id === oldId);
  assert.ok(replaced);
  assert.ok(replaced.supersededBy);
});

test('global records live in global.jsonl', async () => {
  const h = makeHarness();
  await runCli(['remember', 'always use pnpm in this org', '--global'], h);
  const globalPath = path.join(h.home, 'global.jsonl');
  assert.ok(fs.existsSync(globalPath));
  const line = JSON.parse(readLines(globalPath)[0]);
  assert.equal(line.project, 'global');
  assert.equal(line.projectKey, 'global');
});

test('concurrent appends from separate processes do not corrupt the file', async () => {
  const h = makeHarness();
  const project = makeProject(h.root, 'concurrent');
  const workers = 6;

  const jobs = Array.from({ length: workers }, (_, index) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, 'remember', `concurrent fact ${index} ${Date.now()}`], {
      cwd: project,
      env: { ...process.env, RECALL_HOME: h.home },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`worker ${index} failed (${code}): ${stderr}`));
    });
  }));

  await Promise.all(jobs);

  const file = projectDataFile(h.home);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(raw.endsWith('\n'), 'file stays newline-terminated');
  const lines = readLines(file);
  assert.equal(lines.length, workers);
  const records = lines.map((line) => JSON.parse(line));
  assert.equal(new Set(records.map((record) => record.id)).size, workers);
  for (const record of records) assert.match(record.text, /^concurrent fact \d+ /);

  const doctor = await runCli(['doctor', '--json'], h);
  assert.equal(doctor.code, 0);
  const check = JSON.parse(doctor.out).checks.find((c) => c.name === 'data files parse');
  assert.match(check.detail, /0 malformed/);
});

test('CRLF line endings are read correctly', async () => {
  const h = makeHarness();
  await runCli(['remember', 'crlf tolerant record'], h);
  const file = projectDataFile(h.home);
  const content = fs.readFileSync(file, 'utf8').replace(/\n/g, '\r\n');
  fs.writeFileSync(file, content, 'utf8');

  const list = await runCli(['list', '--json'], h);
  assert.equal(list.code, 0);
  assert.equal(JSON.parse(list.out).records.length, 1);
});

test('subdirectories of one project root share memory', async () => {
  const h = makeHarness();
  const root = makeProject(h.root, 'monorepo');
  // A .git marker is enough: if `git rev-parse` is unavailable or fails, the
  // directory containing .git is used as the canonical root.
  fs.mkdirSync(path.join(root, '.git'));
  const sub = makeProject(root, 'packages', 'alpha');

  const saved = await runCli(['remember', 'monorepo shared convention'], { ...h, cwd: sub });
  assert.equal(saved.code, 0);

  const fromRoot = await runCli(['list', '--json'], { ...h, cwd: root });
  const records = JSON.parse(fromRoot.out).records;
  assert.equal(records.length, 1);
  assert.match(records[0].projectPath, /monorepo$/);
});
