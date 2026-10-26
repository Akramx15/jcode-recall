# Remove the jcode-recall Windows install for the current user.
#
# Removes:
#   - the `recall` shim folder (%LOCALAPPDATA%\Programs\recall) and its PATH entry;
#   - the Scheduled Task `jcode-recall-autosave`, if registered. That task is
#     created by `install-windows.ps1 -Autosave`, runs `autosave --once --all --since 7`
#     every 15 minutes, and can also be removed with `-RemoveAutosave`.
#
# Prints (does not remove) the memory data directory, usually ~\.jcode\recall,
# because it contains your records. Delete it yourself if you want a clean slate.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-windows.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-windows.ps1 -DryRun

[CmdletBinding()]
param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$taskName = 'jcode-recall-autosave'
$target = Join-Path $env:LOCALAPPDATA 'Programs\recall'
$home0 = if ($env:RECALL_HOME) { $env:RECALL_HOME } else { Join-Path $HOME '.jcode\recall' }

if ($DryRun) {
    Write-Host '[DRY RUN] No changes will be made.'
}

# 1. Scheduled task.
$foundTask = $false
if (Get-Command Unregister-ScheduledTask -ErrorAction SilentlyContinue) {
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) {
        $foundTask = $true
        if ($DryRun) {
            Write-Host "[DRY RUN] would unregister Scheduled Task '$taskName'"
        } else {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
            Write-Host "[OK] Unregistered Scheduled Task '$taskName'"
        }
    }
} else {
    & schtasks.exe /Query /TN $taskName 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        $foundTask = $true
        if ($DryRun) {
            Write-Host "[DRY RUN] would delete Scheduled Task '$taskName' with schtasks.exe"
        } else {
            & schtasks.exe /Delete /TN $taskName /F 2>$null | Out-Null
            Write-Host "[OK] Unregistered Scheduled Task '$taskName'"
        }
    }
}
if (-not $foundTask) {
    Write-Host "[OK] Scheduled Task '$taskName' is not registered"
}

# 2. Shim folder.
if (Test-Path -LiteralPath $target) {
    if ($DryRun) {
        Write-Host "[DRY RUN] would remove $target"
    } else {
        Remove-Item -LiteralPath $target -Recurse -Force
        Write-Host "[OK] Removed $target"
    }
} else {
    Write-Host "[OK] $target does not exist"
}

# 3. User PATH entry (only if it points at our shim folder).
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath) {
    $parts = @($userPath.Split(';') | Where-Object { $_ })
    if ($parts -contains $target) {
        $kept = @($parts | Where-Object { $_ -ne $target })
        if ($DryRun) {
            Write-Host "[DRY RUN] would remove $target from the user PATH"
        } else {
            [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User')
            Write-Host "[OK] Removed $target from the user PATH (open a new terminal)"
        }
    } else {
        Write-Host "[OK] $target is not on the user PATH"
    }
}

# 4. Data directory: report only, never delete.
Write-Host ''
Write-Host "Memory data kept at: $home0"
Write-Host 'It was not touched. Delete that folder manually only if you want to erase all memories.'
Write-Host ''
Write-Host 'MCP entries in ~\.jcode\mcp.json or .mcp.json are yours to edit; this script never changes them.'
