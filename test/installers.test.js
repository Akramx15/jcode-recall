import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTALL = path.join(ROOT, 'scripts', 'install-windows.ps1');
const UNINSTALL = path.join(ROOT, 'scripts', 'uninstall-windows.ps1');
const VBS = path.join(ROOT, 'scripts', 'autosave-hidden.vbs');
const TASK_NAME = 'jcode-recall-autosave';
const isWindows = process.platform === 'win32';

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function psQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function taskExists() {
  if (!isWindows) return false;
  const result = spawnSync('schtasks.exe', ['/Query', '/TN', TASK_NAME], {
    stdio: 'ignore',
    windowsHide: true,
    timeout: 30000,
  });
  return result.status === 0;
}

test('Windows installer scripts contain the autosave wiring', () => {
  const install = read(INSTALL);
  const uninstall = read(UNINSTALL);

  for (const [name, text] of [['install-windows.ps1', install], ['uninstall-windows.ps1', uninstall]]) {
    assert.ok(text.includes(TASK_NAME), `${name} must name the scheduled task`);
    assert.ok(text.includes('autosave --once'), `${name} must reference autosave --once`);
    assert.ok(text.includes('-Autosave'), `${name} must mention -Autosave`);
    assert.ok(text.includes('-RemoveAutosave'), `${name} must mention -RemoveAutosave`);
    assert.ok(text.includes('-DryRun'), `${name} must support/mention -DryRun`);
  }

  // The install command must stay project-scoped and time-bounded.
  assert.match(install, /autosave --once --all --since 7/);
  assert.match(install, /Register-ScheduledTask/);
  assert.match(install, /schtasks\.exe \/Create/);
  assert.match(install, /-WindowStyle Hidden/);

  // Uninstall must preview-only and must not delete the data directory.
  assert.match(uninstall, /param\([\s\S]*\$DryRun/);
  assert.doesNotMatch(uninstall, /Remove-Item[^\n]*\.jcode/);

  const vbs = read(VBS);
  assert.match(vbs, /autosave --watch/);
  assert.match(vbs, /shell\.Run command, 0, False/);
});

test('installer scripts parse without PowerShell syntax errors', { skip: isWindows ? false : 'Windows only' }, () => {
  const files = [INSTALL, UNINSTALL].map(psQuote).join(', ');
  const script = [
    `$files = @(${files})`,
    '$errors = @()',
    'foreach ($f in $files) {',
    '  $tokens = $null',
    '  $parseErrors = $null',
    '  [void][System.Management.Automation.Language.Parser]::ParseFile($f, [ref]$tokens, [ref]$parseErrors)',
    '  if ($parseErrors) { $errors += $parseErrors }',
    '}',
    'if ($errors.Count -gt 0) {',
    '  $errors | ForEach-Object { Write-Output ("PARSE_ERROR: " + $_.Message) }',
    '  exit 1',
    '}',
    'Write-Output "PARSE_OK"',
  ].join('\n');

  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PARSE_OK/);
});

test('install-windows.ps1 -DryRun -Autosave prints the task without registering it', { skip: isWindows ? false : 'Windows only' }, () => {
  const before = taskExists();

  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INSTALL, '-DryRun', '-Autosave'],
    { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 120000 },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, new RegExp(TASK_NAME));
  assert.match(result.stdout, /autosave --once --all --since 7/);
  assert.match(result.stdout, /\[DRY RUN\] would register Scheduled Task/);
  assert.match(result.stdout, /nothing was registered/);

  const after = taskExists();
  assert.equal(after, before, 'a dry run must not create or remove the scheduled task');
});
