#!/usr/bin/env node
import { main } from '../src/cli.js';

try {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
} catch (error) {
  process.stderr.write(`recall: fatal: ${error && error.stack ? error.stack : error}\n`);
  process.exitCode = 1;
}
