param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('8173', '8186')]
    [string]$Watch,

    [switch]$KeepItem
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$LogDirectory = Join-Path $Root 'artifacts-local'
New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null

$RunStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$RunLogPath = Join-Path $LogDirectory ("studio-{0}-only-{1}.log" -f $Watch, $RunStamp)
$LatestLogPath = Join-Path $LogDirectory ("studio-{0}-only.log" -f $Watch)
$StdoutPath = Join-Path $LogDirectory ("studio-{0}-{1}.stdout.log" -f $Watch, $RunStamp)
$StderrPath = Join-Path $LogDirectory ("studio-{0}-{1}.stderr.log" -f $Watch, $RunStamp)
$ResultPath = Join-Path $LogDirectory ("studio-{0}-result.json" -f $Watch)
$NodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$ExitCode = 1
$NodeProcess = $null

$ProductUrl = if ($Watch -eq '8173') {
    'https://item.rakuten.co.jp/barbizon/sd8173/?variantId=r-sku00000003'
} else {
    'https://item.rakuten.co.jp/auc-americanbass/10018065/'
}

Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
        $_.Name -eq 'node.exe' -and
        $_.CommandLine -match 'studio-single-runner|studio-dartisan-watch|\.studio-(8173|8186)-runtime'
    } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

Start-Sleep -Milliseconds 750

"[$(Get-Date -Format o)] Starting isolated Studio D'Artisan $Watch run" |
    Out-File -FilePath $RunLogPath -Encoding utf8

try {
    Remove-Item $ResultPath -Force -ErrorAction SilentlyContinue

    & powershell.exe -NoProfile -ExecutionPolicy Bypass `
        -File (Join-Path $PSScriptRoot 'start-chrome.ps1') `
        -ProductUrl $ProductUrl *>> $RunLogPath

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
        -ArgumentList @((Join-Path $PSScriptRoot 'studio-single-runner.mjs'), $Watch) `
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
                $WatchResult = @($Candidate.watches)[0]
                $Status = [string]$WatchResult.status
                if (
                    $Candidate.checked_at -and
                    $WatchResult -and
                    $Status -in @('available', 'unavailable', 'error')
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
        $WatchResult = @($TerminalResult.watches)[0]
        $ExitCode = if ($TerminalResult.error -or $WatchResult.error -or $WatchResult.status -eq 'error') { 1 } else { 0 }
        "[$(Get-Date -Format o)] Terminal Studio $Watch JSON detected; released the lingering Node process." |
            Out-File -FilePath $RunLogPath -Append -Encoding utf8
    }
    elseif ($NodeProcess.HasExited) {
        $ExitCode = [int]$NodeProcess.ExitCode
    }
    else {
        Stop-Process -Id $NodeProcess.Id -Force -ErrorAction SilentlyContinue
        $NodeProcess.WaitForExit()
        $ExitCode = 124
        "[$(Get-Date -Format o)] Studio $Watch stage timed out before terminal JSON was written." |
            Out-File -FilePath $RunLogPath -Append -Encoding utf8
    }

    if (Test-Path $StdoutPath) {
        Get-Content $StdoutPath -Raw -ErrorAction SilentlyContinue |
            Out-File -FilePath $RunLogPath -Append -Encoding utf8
    }
    if (Test-Path $StderrPath) {
        Get-Content $StderrPath -Raw -ErrorAction SilentlyContinue |
            Out-File -FilePath $RunLogPath -Append -Encoding utf8
    }
}
catch {
    if ($NodeProcess -and -not $NodeProcess.HasExited) {
        Stop-Process -Id $NodeProcess.Id -Force -ErrorAction SilentlyContinue
    }
    $_ | Out-String | Out-File -FilePath $RunLogPath -Append -Encoding utf8
    $ExitCode = 1
}
finally {
    Remove-Item Env:RAKUTEN_KEEP_ITEM -ErrorAction SilentlyContinue

    "[$(Get-Date -Format o)] Studio $Watch-only run exited with code $ExitCode" |
        Out-File -FilePath $RunLogPath -Append -Encoding utf8

    try {
        Get-Content $RunLogPath -Raw |
            Set-Content -Path $LatestLogPath -Encoding utf8
    }
    catch {
        Write-Warning "Could not refresh $LatestLogPath. The completed run log is $RunLogPath"
    }
}

exit $ExitCode
