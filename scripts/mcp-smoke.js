#!/usr/bin/env node
// End-to-end MCP smoke test: spawns `recall mcp`, speaks newline-delimited
// JSON-RPC over stdio, and fails loudly if anything is off.
//
// Usage: node scripts/mcp-smoke.js

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'recall.js');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-smoke-'));
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-smoke-project-'));

const child = spawn(process.execPath, [BIN, 'mcp'], {
  cwd: CWD,
  env: { ...process.env, RECALL_HOME: HOME },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let buffer = '';
let nextId = 0;
let parseErrors = 0;
const pending = new Map();
let stderrText = '';

child.stderr.on('data', (chunk) => {
  stderrText += chunk.toString();
});

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let index = buffer.indexOf('\n');
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf('\n');
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      parseErrors += 1;
      continue;
    }
    if (message.id === undefined || message.id === null) continue;
    const entry = pending.get(message.id);
    if (!entry) continue;
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(`JSON-RPC error ${message.error.code}: ${message.error.message}`));
    else entry.resolve(message.result);
  }
});

function send(method, params) {
  nextId += 1;
  const id = nextId;
  const payload = { jsonrpc: '2.0', id, method };
  if (params !== undefined) payload.params = params;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method} (id ${id})`));
      }
    }, 8000).unref();
  });
}

function textOf(result) {
  return (result.content || []).map((part) => part.text || '').join('\n');
}

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  process.stdout.write(`  ok  ${label}\n`);
}

try {
  process.stdout.write(`MCP smoke test (home: ${HOME})\n`);

  const init = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-smoke', version: '1.0.0' },
  });
  check('initialize protocol version', () => assert.equal(init.protocolVersion, '2024-11-05'));
  check('initialize capabilities.tools', () => assert.ok(init.capabilities.tools));
  check('initialize server name', () => assert.equal(init.serverInfo.name, 'jcode-recall'));

  const tools = await send('tools/list', {});
  check('tools/list count', () => assert.equal(tools.tools.length, 8));
  check('tools/list names', () => {
    const names = tools.tools.map((tool) => tool.name);
    assert.ok(names.includes('recall_remember'));
    assert.ok(names.includes('recall_resume'));
    assert.ok(names.includes('recall_checkpoint'));
  });

  const remember = await send('tools/call', {
    name: 'recall_remember',
    arguments: { text: 'mcp smoke fact: newline framing works', kind: 'fact', tags: ['smoke'] },
  });
  check('remember returns an id', () => assert.match(textOf(remember), /remembered r[a-z0-9]+/));
  check('remember is not an error', () => assert.notEqual(remember.isError, true));

  const search = await send('tools/call', {
    name: 'recall_search',
    arguments: { query: 'newline framing' },
  });
  check('search finds the record', () => assert.match(textOf(search), /newline framing works/));
  check('search reports provenance', () => assert.match(textOf(search), /smoke/));

  const checkpoint = await send('tools/call', {
    name: 'recall_checkpoint',
    arguments: { goal: 'smoke the MCP server', next_steps: ['ship it'] },
  });
  check('checkpoint saves', () => assert.match(textOf(checkpoint), /checkpoint r/));

  const resume = await send('tools/call', { name: 'recall_resume', arguments: { budget: 800 } });
  check('resume includes the checkpoint goal', () => assert.match(textOf(resume), /smoke the MCP server/));
  check('resume marks content unverified', () => assert.match(textOf(resume), /unverified/));

  const stats = await send('tools/call', { name: 'recall_stats', arguments: {} });
  check('stats works', () => assert.match(textOf(stats), /records:/));

  const ping = await send('ping', {});
  check('ping returns empty result', () => assert.deepEqual(ping, {}));

  check('no stdout parse errors', () => assert.equal(parseErrors, 0));
  check('stderr is quiet', () => assert.equal(stderrText.trim(), ''));

  child.stdin.end();
  const exitCode = await new Promise((resolve) => child.on('exit', resolve));
  check('clean exit', () => assert.equal(exitCode, 0));

  process.stdout.write(`\nMCP smoke: ${checks} checks passed\n`);
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(CWD, { recursive: true, force: true });
  process.exit(0);
} catch (error) {
  process.stderr.write(`\nMCP smoke FAILED after ${checks} checks: ${error && error.stack ? error.stack : error}\n`);
  if (stderrText.trim()) process.stderr.write(`server stderr:\n${stderrText}\n`);
  try { child.kill(); } catch { /* ignore */ }
  process.exit(1);
}
