import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';

import { handleMessage, runMcp } from '../src/mcp.js';
import { createSession } from '../src/service.js';
import { makeHarness } from './helpers.js';

function sessionFor(h) {
  return createSession({ env: h.env, cwd: h.cwd });
}

function callTool(h, name, args) {
  const response = handleMessage({
    jsonrpc: '2.0',
    id: 99,
    method: 'tools/call',
    params: { name, arguments: args },
  }, sessionFor(h));
  assert.ok(response.result, JSON.stringify(response));
  const text = response.result.content[0].text;
  return { text, isError: response.result.isError === true };
}

test('initialize advertises the 2024-11-05 protocol and tools capability', () => {
  const h = makeHarness();
  const response = handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, sessionFor(h));
  assert.equal(response.id, 1);
  assert.equal(response.result.protocolVersion, '2024-11-05');
  assert.ok(response.result.capabilities.tools);
  assert.equal(response.result.serverInfo.name, 'jcode-recall');
  assert.match(response.result.instructions, /recall_resume/);
});

test('tools/list returns the eight documented tools with schemas', () => {
  const h = makeHarness();
  const response = handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionFor(h));
  const names = response.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'recall_brief',
    'recall_checkpoint',
    'recall_forget',
    'recall_pin',
    'recall_remember',
    'recall_resume',
    'recall_search',
    'recall_stats',
  ]);
  for (const tool of response.result.tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(tool.description.length > 10);
  }
});

test('tools/call remember then search returns the record', () => {
  const h = makeHarness();
  const remembered = callTool(h, 'recall_remember', {
    text: 'MCP tool writes the migration note',
    kind: 'decision',
    tags: ['mcp'],
    importance: 4,
  });
  assert.equal(remembered.isError, false);
  assert.match(remembered.text, /remembered r/);
  const id = remembered.text.match(/remembered (\S+)/)[1];

  const found = callTool(h, 'recall_search', { query: 'migration note' });
  assert.match(found.text, /MCP tool writes/);
  assert.match(found.text, new RegExp(id));
});

test('tools/call duplicate remember is reported as a duplicate', () => {
  const h = makeHarness();
  callTool(h, 'recall_remember', { text: 'dedupe me twice' });
  const second = callTool(h, 'recall_remember', { text: 'dedupe me twice' });
  assert.match(second.text, /^duplicate/);
});

test('checkpoint, resume, pin, forget and stats work over MCP', () => {
  const h = makeHarness();
  const checkpoint = callTool(h, 'recall_checkpoint', {
    goal: 'finish the importer',
    decisions: ['stream rows'],
    files_touched: ['src/csv.js'],
    next_steps: ['add fixture'],
  });
  assert.match(checkpoint.text, /checkpoint r/);
  assert.match(checkpoint.text, /finish the importer/);

  const resumed = callTool(h, 'recall_resume', {});
  assert.match(resumed.text, /Latest checkpoint/);
  assert.match(resumed.text, /finish the importer/);
  assert.match(resumed.text, /unverified/);

  const remembered = callTool(h, 'recall_remember', { text: 'pin me via mcp' });
  const id = remembered.text.match(/remembered (\S+)/)[1];
  assert.match(callTool(h, 'recall_pin', { id }).text, /^pinned/);
  assert.match(callTool(h, 'recall_pin', { id, pinned: false }).text, /^unpinned/);

  const stats = callTool(h, 'recall_stats', {});
  assert.match(stats.text, /records:/);

  assert.match(callTool(h, 'recall_forget', { id }).text, /^forgot/);
  const after = callTool(h, 'recall_search', { query: 'pin me via mcp' });
  assert.match(after.text, /_0 hits/);
});

test('MCP errors: unknown tool, unknown method, invalid request', () => {
  const h = makeHarness();
  const unknownTool = handleMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'nope', arguments: {} },
  }, sessionFor(h));
  assert.equal(unknownTool.result.isError, true);
  assert.match(unknownTool.result.content[0].text, /unknown tool/);

  const unknownMethod = handleMessage({ jsonrpc: '2.0', id: 4, method: 'resources/list' }, sessionFor(h));
  assert.equal(unknownMethod.error.code, -32601);

  const invalid = handleMessage({ jsonrpc: '2.0', id: 5 }, sessionFor(h));
  assert.equal(invalid.error.code, -32600);

  const missingArgs = handleMessage({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'recall_remember', arguments: {} },
  }, sessionFor(h));
  assert.equal(missingArgs.result.isError, true);
  assert.match(missingArgs.result.content[0].text, /text is required/);
});

test('notifications produce no response and ping works', () => {
  const h = makeHarness();
  assert.equal(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionFor(h)), null);
  const ping = handleMessage({ jsonrpc: '2.0', id: 7, method: 'ping' }, sessionFor(h));
  assert.deepEqual(ping.result, {});
});

test('stdio framing handles split chunks, CRLF and multiple messages', async () => {
  const h = makeHarness();
  const input = new PassThrough();
  const chunks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });

  const done = runMcp({
    stdin: input,
    stdout: output,
    stderr: { write() {} },
    env: h.env,
    cwd: h.cwd,
  });

  const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  input.write(initialize.slice(0, 25));
  await new Promise((resolve) => setTimeout(resolve, 10));
  input.write(`${initialize.slice(25)}\r\n`);

  const remember = JSON.stringify({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'recall_remember', arguments: { text: 'split chunk fact' } },
  });
  input.write(remember.slice(0, 50));
  await new Promise((resolve) => setTimeout(resolve, 10));
  input.write(`${remember.slice(50)}\n`);

  input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' })}\n`);
  input.write('{ this is not json }\n');
  input.end();

  const code = await done;
  assert.equal(code, 0);

  const lines = chunks.join('').trim().split('\n').map((line) => JSON.parse(line));
  const byId = new Map(lines.filter((line) => line.id !== undefined && line.id !== null).map((line) => [line.id, line]));
  assert.equal(byId.get(1).result.protocolVersion, '2024-11-05');
  assert.match(byId.get(2).result.content[0].text, /remembered/);
  assert.equal(byId.get(3).result.tools.length, 8);
  assert.ok(lines.some((line) => line.error && line.error.code === -32700), 'parse error reported');
});
