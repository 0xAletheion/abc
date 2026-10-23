param(
    [switch]$KeepItem
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$LogDirectory = Join-Path $Root 'artifacts-local'
New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null

$RunStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$LogPath = Join-Path $LogDirectory 'fullcount-only.log'
$StdoutPath = Join-Path $LogDirectory ("fullcount-{0}.stdout.log" -f $RunStamp)
$StderrPath = Join-Path $LogDirectory ("fullcount-{0}.stderr.log" -f $RunStamp)
$ResultPath = Join-Path $LogDirectory 'result.json'
$NodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$ExitCode = 1
$NodeProcess = $null

"`n[$(Get-Date -Format o)] Starting isolated Fullcount 1110 W33 run" |
    Out-File -FilePath $LogPath -Append -Encoding utf8

try {
    Remove-Item $ResultPath -Force -ErrorAction SilentlyContinue

    & powershell.exe -NoProfile -ExecutionPolicy Bypass `
        -File (Join-Path $PSScriptRoot 'start-chrome.ps1') *>> $LogPath

    if ($LASTEXITCODE -ne 0) {
        throw "Dedicated Chrome startup failed with exit code $LASTEXITCODE."
    }

    Start-Sleep -Seconds 2

    if ($KeepItem) {
        $env:RAKUTEN_KEEP_ITEM = '1'
    } else {
        Remove-Item Env:RAKUTEN_KEEP_ITEM -ErrorAction SilentlyContinue
    }

    $NodeProcess = Start-Process `
        -FilePath $NodeExe `
        -ArgumentList @((Join-Path $PSScriptRoot 'local-monitor-runner.mjs')) `
        -PassThru `
        -NoNewWindow `
        -RedirectStandardOutput $StdoutPath `
        -RedirectStandardError $StderrPath

    $Deadline = [DateTime]::UtcNow.AddMinutes(5)
    $TerminalResult = $null

    while ([DateTime]::UtcNow -lt $Deadline) {
        if (Test-Path $ResultPath) {
            try {
                $Candidate = Get-Content $ResultPath -Raw | ConvertFrom-Json
                $Status = [string]$Candidate.w33.status
                if (
                    $Candidate.checked_at -and
                    (($Status -and $Status -notin @('unknown', 'starting')) -or $Candidate.error)
                ) {
                    $TerminalResult = $Candidate
                    break
                }
            }
            catch {}
        }

        $NodeProcess.Refresh()
        if ($NodeProcess.HasExited) {
            break
        }
        Start-Sleep -Milliseconds 500
    }

    $NodeProcess.Refresh()

    if ($TerminalResult) {
        if (-not $NodeProcess.HasExited) {
            Stop-Process -Id $NodeProcess.Id -Force -ErrorAction SilentlyContinue
            $NodeProcess.WaitForExit()
        }
        $ExitCode = if ($TerminalResult.error) { 1 } else { 0 }
        "[$(Get-Date -Format o)] Terminal Fullcount JSON detected; released the lingering Node process." |
            Out-File -FilePath $LogPath -Append -Encoding utf8
    }
    elseif ($NodeProcess.HasExited) {
        $ExitCode = [int]$NodeProcess.ExitCode
    }
    else {
        Stop-Process -Id $NodeProcess.Id -Force -ErrorAction SilentlyContinue
        $NodeProcess.WaitForExit()
        $ExitCode = 124
        "[$(Get-Date -Format o)] Fullcount stage timed out before terminal JSON was written." |
            Out-File -FilePath $LogPath -Append -Encoding utf8
    }

    if (Test-Path $StdoutPath) {
        Get-Content $StdoutPath -Raw -ErrorAction SilentlyContinue |
            Out-File -FilePath $LogPath -Append -Encoding utf8
    }
    if (Test-Path $StderrPath) {
        Get-Content $StderrPath -Raw -ErrorAction SilentlyContinue |
            Out-File -FilePath $LogPath -Append -Encoding utf8
    }
}
catch {
    if ($NodeProcess -and -not $NodeProcess.HasExited) {
        Stop-Process -Id $NodeProcess.Id -Force -ErrorAction SilentlyContinue
    }
    $_ | Out-String | Out-File -FilePath $LogPath -Append -Encoding utf8
    $ExitCode = 1
}
finally {
    Remove-Item Env:RAKUTEN_KEEP_ITEM -ErrorAction SilentlyContinue
}

"[$(Get-Date -Format o)] Fullcount-only run exited with code $ExitCode" |
    Out-File -FilePath $LogPath -Append -Encoding utf8

exit $ExitCode
