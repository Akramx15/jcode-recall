# Install jcode-recall for the current user on Windows.
#
# Does three things, all reversible by deleting the target folder:
#   1. checks that Node.js 20+ is available;
#   2. installs a `recall.cmd` shim under %LOCALAPPDATA%\Programs\recall;
#   3. prints the MCP block for Jcode (it never edits your config).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$entry = Join-Path $root 'bin\recall.js'
if (-not (Test-Path $entry)) {
    throw "Cannot find $entry. Run this from a full checkout."
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw 'Node.js was not found on PATH. Install Node 20 or newer, then retry.'
}
$version = (& node --version).TrimStart('v')
$major = [int]($version.Split('.')[0])
if ($major -lt 20) {
    throw "Node.js $version is too old. This project needs Node 20 or newer."
}
Write-Host "[OK] Node.js $version at $($node.Source)"

$target = Join-Path $env:LOCALAPPDATA 'Programs\recall'
New-Item -ItemType Directory -Force -Path $target | Out-Null

$shim = @"
@echo off
node "$entry" %*
"@
Set-Content -Path (Join-Path $target 'recall.cmd') -Value $shim -Encoding ASCII
Write-Host "[OK] Installed shim: $target\recall.cmd"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @()
if ($userPath) { $parts = $userPath.Split(';') | Where-Object { $_ } }
if ($parts -notcontains $target) {
    [Environment]::SetEnvironmentVariable('Path', (($parts + $target) -join ';'), 'User')
    Write-Host "[OK] Added $target to the user PATH (open a new terminal)"
} else {
    Write-Host "[OK] $target is already on the user PATH"
}

$mcpPath = Join-Path $root 'bin\recall.js'
$jsonEntry = [ordered]@{
    command = 'node'
    args    = @($mcpPath, 'mcp')
    env     = @{ RECALL_HOME = (Join-Path $HOME '.jcode\recall') }
    shared  = $true
    enabled = $true
}

Write-Host ''
Write-Host 'Add this server to %USERPROFILE%\.jcode\mcp.json under "servers":'
Write-Host ''
$jsonEntry | ConvertTo-Json -Depth 4
Write-Host ''
Write-Host 'Then verify with:  jcode mcp test recall'
Write-Host 'Optional: copy hooks.example.json entries into your agent hooks, or add'
Write-Host 'the six-line protocol from docs\AGENT-PROTOCOL.md to ~/.jcode/prompt-overlay.md.'
