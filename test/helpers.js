// Shared test helpers. Not a test file itself (it registers no tests).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { main } from '../src/cli.js';

export const FIXED_NOW = new Date('2026-10-26T12:00:00.000Z');

export function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'recall-test-'));
}

export function makeHarness(options = {}) {
  const root = options.root || tempRoot();
  const home = path.join(root, 'home');
  const cwd = options.cwd || path.join(root, 'repo');
  fs.mkdirSync(cwd, { recursive: true });
  return {
    root,
    home,
    cwd,
    env: { RECALL_HOME: home, ...(options.env || {}) },
    now: options.now || FIXED_NOW,
  };
}

export function makeProject(root, ...segments) {
  const dir = path.join(root, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Run the CLI in-process with captured output. */
export async function runCli(argv, harness, options = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, {
    env: options.env || harness.env,
    cwd: options.cwd || harness.cwd,
    now: options.now || harness.now,
    stdinText: options.stdin === undefined ? '' : options.stdin,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
  });
  return { code, out: out.join(''), err: err.join('') };
}

export function dataFiles(home) {
  let names = [];
  try {
    names = fs.readdirSync(home);
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith('.jsonl')).map((name) => path.join(home, name));
}

export function projectDataFile(home) {
  const files = dataFiles(home).filter((file) => !file.endsWith('global.jsonl'));
  if (files.length !== 1) throw new Error(`expected one project file, found ${files.length}: ${files.join(', ')}`);
  return files[0];
}

export function readLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
}

/** Rough token estimate identical to the shipped implementation. */
export function tokens(text) {
  return Math.ceil(String(text || '').length / 4);
}
