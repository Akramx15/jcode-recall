import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { handleMessage } from '../src/mcp.js';
import { createSession } from '../src/service.js';
import { watchSessions } from '../src/import.js';
import { makeHarness, runCli } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/recall.js', import.meta.url));

function sessionsDir(h) {
  const dir = path.join(h.root, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function message(id, role, text) {
  return { id, role, content: [{ type: 'text', text }], timestamp: new Date().toISOString() };
}

function writeSnapshot(dir, name, { id, workingDir, goal, extra = [] }) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify({
    id,
    title: goal,
    working_dir: workingDir,
    short_name: 'test',
    messages: [message(`${id}-user`, 'user', goal), ...extra],
  }), 'utf8');
  return file;
}

function writeJournal(dir, name, { id, workingDir, messages }) {
  const file = path.join(dir, name);
  const lines = messages.map((entry) => JSON.stringify({
    meta: { id, working_dir: workingDir, short_name: 'test' },
    append_messages: [entry],
  }));
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  return file;
}

async function listRecords(h) {
  const result = await runCli(['export', '--format', 'json'], h);
  assert.equal(result.code, 0, result.err);
  return JSON.parse(result.out).records;
}

test('import-session saves one checkpoint and is idempotent across restarts', async () => {
  const h = makeHarness();
  const dir = sessionsDir(h);
  writeSnapshot(dir, 'session_owl_1_aaa.json', {
    id: 'session_owl_1_aaa',
    workingDir: h.cwd,
    goal: 'Ship the login fix',
    extra: [
      message('session_owl_1_aaa-a', 'assistant', 'We decided to use argon2 because it is memory-hard.'),
      { id: 'session_owl_1_aaa-t', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'npm test' } }] },
    ],
  });

  const first = await runCli(['import-session', '--dir', dir, '--json'], h);
  assert.equal(first.code, 0, first.err);
  const parsed = JSON.parse(first.out);
  assert.equal(parsed.checkpoints, 1);
  assert.match(parsed.lastCheckpointId, /^r/);

  let records = await listRecords(h);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'handoff');
  assert.equal(records[0].data.goal, 'Ship the login fix');
  assert.match(records[0].text, /argon2/);

  const second = await runCli(['import-session', '--dir', dir, '--json'], h);
  assert.equal(second.code, 0, second.err);
  const secondParsed = JSON.parse(second.out);
  assert.equal(secondParsed.checkpoints, 0);
  assert.equal(secondParsed.updated, 0);
  assert.equal(secondParsed.unchanged, 1);
  assert.equal((await listRecords(h)).length, 1, 'second run must not duplicate');

  const child = spawnSync(process.execPath, [BIN, 'import-session', '--dir', dir], {
    cwd: h.cwd,
    env: { ...h.env, RECALL_HOME: h.home },
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /imported 0 session\(s\)/);
  assert.equal((await listRecords(h)).length, 1, 'ledger survives a process restart');
});

test('two sessions with the same basename but different ids do not overwrite each other', async () => {
  const h = makeHarness();
  const dirA = path.join(h.root, 'a');
  const dirB = path.join(h.root, 'b');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  writeSnapshot(dirA, 'session_shared.json', { id: 'session_one', workingDir: h.cwd, goal: 'First session goal' });
  writeSnapshot(dirB, 'session_shared.json', { id: 'session_two', workingDir: h.cwd, goal: 'Second session goal' });

  assert.equal((await runCli(['import-session', '--dir', dirA], h)).code, 0);
  assert.equal((await runCli(['import-session', '--dir', dirB], h)).code, 0);

  const records = await listRecords(h);
  assert.equal(records.length, 2);
  assert.ok(records.some((record) => record.data.goal === 'First session goal'));
  assert.ok(records.some((record) => record.data.goal === 'Second session goal'));
});

test('autosave defaults to this project and a 7-day window; --all and --since widen it', async () => {
  const h = makeHarness();
  const dir = sessionsDir(h);
  const other = path.join(h.root, 'other-project');
  fs.mkdirSync(other, { recursive: true });

  writeSnapshot(dir, 'session_current_1_aaa.json', { id: 'session_current_1_aaa', workingDir: h.cwd, goal: 'Current project goal' });
  writeSnapshot(dir, 'session_other_1_bbb.json', { id: 'session_other_1_bbb', workingDir: other, goal: 'Other project goal' });
  const oldFile = writeSnapshot(dir, 'session_old_1_ccc.json', { id: 'session_old_1_ccc', workingDir: h.cwd, goal: 'Old project goal' });
  const oldTime = new Date(Date.now() - (30 * 86400000));
  fs.utimesSync(oldFile, oldTime, oldTime);

  const once = await runCli(['autosave', '--once', '--dir', dir, '--json'], h);
  assert.equal(once.code, 0, once.err);
  const first = JSON.parse(once.out);
  assert.equal(first.checkpoints, 1);
  assert.equal(first.filteredProject, 1);
  assert.equal(first.filteredOld, 1);
  let records = await listRecords(h);
  assert.equal(records.length, 1);
  assert.equal(records[0].data.goal, 'Current project goal');

  const wide = await runCli(['autosave', '--once', '--all', '--since', '1', '--dir', dir, '--json'], h);
  assert.equal(wide.code, 0, wide.err);
  const second = JSON.parse(wide.out);
  assert.equal(second.checkpoints, 1, 'only the recent other project is imported');
  assert.equal(second.filteredOld, 1);
  assert.ok((await listRecords(h)).some((record) => record.data.goal === 'Other project goal'));

  const all = await runCli(['autosave', '--once', '--all', '--since', '365', '--dir', dir, '--json'], h);
  assert.equal(all.code, 0, all.err);
  assert.equal(JSON.parse(all.out).checkpoints, 1, 'the old session is now inside the window');
  records = await listRecords(h);
  assert.equal(records.length, 3);
  assert.ok(records.some((record) => record.data.goal === 'Old project goal'));
});

test('--project attributes every imported session to the requested project', async () => {
  const h = makeHarness();
  const dir = sessionsDir(h);
  const app = path.join(h.root, 'app-install');
  fs.mkdirSync(app, { recursive: true });
  writeSnapshot(dir, 'session_installed_1_aaa.json', {
    id: 'session_installed_1_aaa',
    workingDir: app,
    goal: 'Launcher cwd session',
  });

  const result = await runCli([
    'import-session', '--dir', dir, '--project', h.cwd, '--json',
  ], h);
  assert.equal(result.code, 0, result.err);
  const records = await listRecords(h);
  assert.equal(records.length, 1);
  assert.equal(records[0].projectKey, h.cwd.toLowerCase().replace(/\\/g, '/'));
  assert.match(records[0].text, /Launcher cwd session/);
});

test('autosave imports user preferences and records a rejected command state', async () => {
  const h = makeHarness();
  const dir = sessionsDir(h);
  writeSnapshot(dir, 'session_prefs_1_aaa.json', {
    id: 'session_prefs_1_aaa',
    workingDir: h.cwd,
    goal: 'Wire the package manager',
    extra: [
      message('session_prefs_1_aaa-pref', 'user', 'Always use pnpm not npm in this repo.'),
      { id: 'session_prefs_1_aaa-tool', role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'npm test' } }] },
      { id: 'session_prefs_1_aaa-result', role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '1 failing', is_error: true }] },
    ],
  });

  const result = await runCli(['autosave', '--once', '--dir', dir, '--json'], h);
  assert.equal(result.code, 0, result.err);
  const parsed = JSON.parse(result.out);
  assert.equal(parsed.checkpoints, 1);
  assert.equal(parsed.preferences, 1);

  const records = await listRecords(h);
  const checkpoint = records.find((record) => record.kind === 'handoff');
  const preference = records.find((record) => record.kind === 'preference');
  assert.ok(checkpoint, 'checkpoint created');
  assert.match(checkpoint.text, /npm test \[fail\]/);
  assert.ok(checkpoint.data.commands.length <= 6);
  assert.equal(checkpoint.data.commands[0].result, '');
  assert.doesNotMatch(checkpoint.text, /1 failing/);
  assert.ok(preference, 'preference created');
  assert.match(preference.text, /pnpm not npm/);
});

test('--watch picks up an appended journal message and stops cleanly', async () => {
  const h = makeHarness();
  const dir = sessionsDir(h);
  writeSnapshot(dir, 'session_watch_1_aaa.json', {
    id: 'session_watch_1_aaa',
    workingDir: h.cwd,
    goal: 'Build the watcher',
  });

  const controller = new AbortController();
  let journalAdded = false;
  let final;
  const done = watchSessions(createSession({ env: h.env, cwd: h.cwd }), {
    scope: 'project',
    dir,
    intervalMs: 20,
    signal: controller.signal,
    onTick: (result) => {
      if (!journalAdded) {
        journalAdded = true;
        setTimeout(() => {
          writeJournal(dir, 'session_watch_1_aaa.journal.jsonl', {
            id: 'session_watch_1_aaa',
            workingDir: h.cwd,
            messages: [
              message('session_watch_1_aaa-next', 'user', 'Next, add the watcher assertion in test/import.test.js.'),
            ],
          });
        }, 15);
      }
      if (result.updated > 0) controller.abort();
    },
  });
  final = await done;

  assert.equal(final.stopped, true);
  assert.equal(final.reason, 'aborted');
  assert.equal(final.updated === undefined || final.updated === 0, true);
  assert.equal(fs.existsSync(path.join(h.home, 'import.lock')), false, 'lock released');

  const records = await listRecords(h);
  const checkpoint = records.find((record) => record.kind === 'handoff');
  assert.match(checkpoint.text, /watcher assertion/);
  assert.equal(records.filter((record) => record.kind === 'handoff').length, 1, 'one checkpoint per session');
});

test('MCP exposes recall_import_session and imports a directory', async () => {
  const h = makeHarness();
  const dir = sessionsDir(h);
  writeSnapshot(dir, 'session_mcp_1_aaa.json', {
    id: 'session_mcp_1_aaa',
    workingDir: h.cwd,
    goal: 'Import through MCP',
  });
  const session = createSession({ env: h.env, cwd: h.cwd });

  const tools = handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, session);
  assert.equal(tools.result.tools.length, 9);
  assert.ok(tools.result.tools.some((tool) => tool.name === 'recall_import_session'));

  const response = handleMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'recall_import_session', arguments: { dir } },
  }, session);
  assert.ok(response.result, JSON.stringify(response));
  const text = response.result.content[0].text;
  assert.match(text, /imported 1 session\(s\), 1 checkpoint\(s\)/);
  assert.match(text, /unverified/);

  const second = handleMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'recall_import_session', arguments: { dir } },
  }, session);
  assert.match(second.result.content[0].text, /imported 0 session\(s\)/);
});

test('import-session --help works and prints the new commands', async () => {
  const h = makeHarness();
  const result = await runCli(['import-session', '--help'], h);
  assert.equal(result.code, 0);
  assert.match(result.out, /import-session/);
  assert.match(result.out, /autosave/);
});
