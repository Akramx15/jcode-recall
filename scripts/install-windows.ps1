# Install jcode-recall for the current user on Windows.
#
# Does three things, all reversible by deleting the target folder:
#   1. checks that Node.js 20+ is available;
#   2. installs a `recall.cmd` shim under %LOCALAPPDATA%\Programs\recall;
#   3. prints the MCP block for Jcode (it never edits your config).
#
# Optional zero-effort capture (opt-in, per-user, no admin required):
#   -Autosave         register the Scheduled Task `jcode-recall-autosave`, which
#                     runs `autosave --once --all --since 7` at logon and every 15 min
#   -RemoveAutosave   unregister that Scheduled Task and exit
#   -WorkingDirectory project directory the task runs in (default: current dir)
#   -DryRun           print every action without changing anything
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -Autosave
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -RemoveAutosave
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-windows.ps1 -DryRun -Autosave

[CmdletBinding()]
param(
    [switch]$Autosave,
    [switch]$RemoveAutosave,
    [switch]$DryRun,
    [string]$WorkingDirectory = ''
)

$ErrorActionPreference = 'Stop'

$taskName = 'jcode-recall-autosave'
$taskArgument = 'autosave --once --all --since 7'
$intervalMinutes = 15

function Get-AutosaveCommandLine {
    param([string]$NodeExe, [string]$Entry)
    return '"' + $NodeExe + '" "' + $Entry + '" ' + $script:taskArgument
}

function Quote-SingleQuoted {
    param([string]$Value)
    return "'" + $Value.Replace("'", "''") + "'"
}

function Remove-AutosaveTask {
    param([switch]$WhatIfOnly)

    $removed = $false
    $cmdlet = Get-Command Unregister-ScheduledTask -ErrorAction SilentlyContinue
    if ($cmdlet) {
        $existing = Get-ScheduledTask -TaskName $script:taskName -ErrorAction SilentlyContinue
        if ($existing) {
            if ($WhatIfOnly) {
                Write-Host "[DRY RUN] would unregister Scheduled Task '$($script:taskName)'"
                return $true
            }
            Unregister-ScheduledTask -TaskName $script:taskName -Confirm:$false
            $removed = $true
        }
    } else {
        $query = & schtasks.exe /Query /TN $script:taskName 2>$null
        if ($LASTEXITCODE -eq 0) {
            if ($WhatIfOnly) {
                Write-Host "[DRY RUN] would delete Scheduled Task '$($script:taskName)' with schtasks.exe"
                return $true
            }
            & schtasks.exe /Delete /TN $script:taskName /F 2>$null | Out-Null
            if ($LASTEXITCODE -eq 0) { $removed = $true }
        }
    }

    if ($removed) {
        Write-Host "[OK] Unregistered Scheduled Task '$($script:taskName)'"
    } else {
        Write-Host "[OK] Scheduled Task '$($script:taskName)' is not registered (nothing to remove)"
    }
    return $removed
}

if ($RemoveAutosave) {
    if ($Autosave) {
        throw 'Use either -Autosave or -RemoveAutosave, not both.'
    }
    Remove-AutosaveTask -WhatIfOnly:$DryRun | Out-Null
    Write-Host ''
    Write-Host 'Automatic capture stopped. Stored memories were not touched.'
    Write-Host 'To remove the command shim too, run: powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-windows.ps1 -DryRun'
    exit 0
}

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
$shimPath = Join-Path $target 'recall.cmd'
if ($DryRun) {
    Write-Host "[DRY RUN] would create $target and write $shimPath"
} else {
    New-Item -ItemType Directory -Force -Path $target | Out-Null

    $shim = @"
@echo off
node "$entry" %*
"@
    Set-Content -Path $shimPath -Value $shim -Encoding ASCII
    Write-Host "[OK] Installed shim: $shimPath"
}

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$parts = @()
if ($userPath) { $parts = $userPath.Split(';') | Where-Object { $_ } }
if ($parts -notcontains $target) {
    if ($DryRun) {
        Write-Host "[DRY RUN] would add $target to the user PATH"
    } else {
        [Environment]::SetEnvironmentVariable('Path', (($parts + $target) -join ';'), 'User')
        Write-Host "[OK] Added $target to the user PATH (open a new terminal)"
    }
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

if ($Autosave) {
    $nodeExe = $node.Source
    $workDir = $WorkingDirectory
    if (-not $workDir) { $workDir = (Get-Location).Path }
    if (-not (Test-Path -LiteralPath $workDir -PathType Container)) {
        throw "Working directory not found: $workDir"
    }
    $workDir = (Resolve-Path -LiteralPath $workDir).Path
    $commandLine = Get-AutosaveCommandLine -NodeExe $nodeExe -Entry $entry
    # Task Scheduler has no per-action window style, so run the command through
    # PowerShell with -WindowStyle Hidden to avoid a console flash every 15 min.
    $innerCommand = '& ' + (Quote-SingleQuoted $nodeExe) + ' ' + (Quote-SingleQuoted $entry) + ' ' + $taskArgument
    $wrapperArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "' + $innerCommand + '"'

    Write-Host ''
    Write-Host 'Zero-effort capture (per-user Scheduled Task):'
    Write-Host "  task name : $taskName"
    Write-Host "  schedule  : every $intervalMinutes minutes (at logon where permitted)"
    Write-Host "  workdir   : $workDir"
    Write-Host "  command   : $commandLine"
    Write-Host "  launcher  : powershell.exe $wrapperArguments"
    Write-Host '  scope     : every project touched in the last 7 days (one file per project)'

    $registered = $false
    if ($DryRun) {
        Write-Host "[DRY RUN] would register Scheduled Task '$taskName'; nothing was registered."
    } else {
        if (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue) {
            try {
                $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $wrapperArguments -WorkingDirectory $workDir
                $trigger = New-ScheduledTaskTrigger -AtLogOn
                $once = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes $intervalMinutes)
                $trigger.Repetition = $once.Repetition
                $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
                $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
                Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'jcode-recall zero-effort capture (autosave --once)' -Force -ErrorAction Stop | Out-Null
                $registered = $true
                Write-Host "[OK] Registered Scheduled Task '$taskName' for the current user (at logon + every $intervalMinutes minutes, no admin needed)"
            } catch {
                Write-Host "[WARN] Logon-trigger registration was refused: $($_.Exception.Message)"
                Write-Host '       Falling back to a 15-minute schedule with schtasks.exe (still no admin needed).'
            }
        }

        if (-not $registered) {
            # Fallback: minute schedule, created by the current user. Runs every
            # 15 minutes while the user is logged on and survives reboots.
            $create = 'schtasks.exe /Create /SC MINUTE /MO ' + $intervalMinutes + ' /TN "' + $taskName + '" /TR "\"' + $nodeExe + '\" \"' + $entry + '\" ' + $taskArgument + '" /F'
            cmd.exe /c $create | Out-Null
            if ($LASTEXITCODE -ne 0) {
                throw "schtasks.exe failed to register '$taskName' (exit $LASTEXITCODE)."
            }
            Write-Host "[OK] Registered Scheduled Task '$taskName' with schtasks.exe (every $intervalMinutes minutes, no admin needed)"
        }
    }

    Write-Host ''
    if ($DryRun) {
        Write-Host "[DRY RUN] to register for real, rerun without -DryRun."
    } else {
        Write-Host 'The task is visible in Task Scheduler as jcode-recall-autosave.'
    }
    Write-Host "To stop automatic capture: powershell -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -RemoveAutosave"
    Write-Host 'To remove everything:       powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-windows.ps1'
}
