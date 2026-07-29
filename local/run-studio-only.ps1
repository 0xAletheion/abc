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

$ProductUrl = if ($Watch -eq '8173') {
    'https://item.rakuten.co.jp/barbizon/sd8173/?variantId=r-sku00000003'
} else {
    'https://item.rakuten.co.jp/auc-americanbass/10018065/'
}

# Stop only stale Studio monitor Node processes. This prevents an earlier hung run
# from retaining the log file or controlling the dedicated Chrome tab.
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

    & node '.\local\studio-single-runner.mjs' $Watch *>> $RunLogPath
    $ExitCode = $LASTEXITCODE
}
catch {
    $_ | Out-String | Out-File -FilePath $RunLogPath -Append -Encoding utf8
    $ExitCode = 1
}
finally {
    Remove-Item Env:RAKUTEN_KEEP_ITEM -ErrorAction SilentlyContinue

    "[$(Get-Date -Format o)] Studio $Watch-only run exited with code $ExitCode" |
        Out-File -FilePath $RunLogPath -Append -Encoding utf8

    # Publish a stable latest-log copy only after the unique run log is closed.
    try {
        Get-Content $RunLogPath -Raw |
            Set-Content -Path $LatestLogPath -Encoding utf8
    }
    catch {
        Write-Warning "Could not refresh $LatestLogPath. The completed run log is $RunLogPath"
    }
}

exit $ExitCode
