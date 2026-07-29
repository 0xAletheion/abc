param(
    [switch]$KeepItem
)

$ErrorActionPreference = 'Stop'
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}

$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$LogDirectory = Join-Path $Root 'artifacts-local'
New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null

$RunStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$RunLogPath = Join-Path $LogDirectory ("three-watch-{0}.log" -f $RunStamp)
$LatestLogPath = Join-Path $LogDirectory 'scheduled-task.log'

$Mutex = New-Object System.Threading.Mutex($false, 'RakutenThreeWatchValidated')
$HasMutex = $false
$ExitCode = 1

try {
    $HasMutex = $Mutex.WaitOne(0)
    if (-not $HasMutex) {
        "[$(Get-Date -Format o)] Another validated three-watch run is already active; this invocation was skipped." |
            Out-File -FilePath $RunLogPath -Encoding utf8
        $ExitCode = 0
        return
    }

    "[$(Get-Date -Format o)] Starting validated Rakuten three-watch run" |
        Out-File -FilePath $RunLogPath -Encoding utf8

    # Remove only stale Studio monitor Node processes. The Fullcount monitor has
    # its own PID-aware lock and should be allowed to manage itself.
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -eq 'node.exe' -and
            $_.CommandLine -match 'studio-single-runner|studio-dartisan-watch|\.studio-(8173|8186)-runtime'
        } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }

    Start-Sleep -Milliseconds 750

    # Delete only current-run outputs. Each monitor will recreate its own file,
    # including a structured error result if generation or browser automation fails.
    Remove-Item '.\artifacts-local\result.json' -Force -ErrorAction SilentlyContinue
    Remove-Item '.\artifacts-local\studio-8173-result.json' -Force -ErrorAction SilentlyContinue
    Remove-Item '.\artifacts-local\studio-8186-result.json' -Force -ErrorAction SilentlyContinue
    Remove-Item '.\artifacts-local\three-watch-result.json' -Force -ErrorAction SilentlyContinue

    & powershell.exe -NoProfile -ExecutionPolicy Bypass `
        -File (Join-Path $PSScriptRoot 'start-chrome.ps1') `
        -Minimized `
        -ProductUrl 'https://item.rakuten.co.jp/realmoon/1110w/' *>> $RunLogPath

    if ($LASTEXITCODE -ne 0) {
        throw "Dedicated Chrome startup failed with exit code $LASTEXITCODE."
    }

    if ($KeepItem) {
        $env:RAKUTEN_KEEP_ITEM = '1'
    } else {
        Remove-Item Env:RAKUTEN_KEEP_ITEM -ErrorAction SilentlyContinue
    }

    "[$(Get-Date -Format o)] Running validated Fullcount 1110W W33 monitor" |
        Out-File -FilePath $RunLogPath -Append -Encoding utf8
    & node '.\local\local-monitor-runner.mjs' *>> $RunLogPath
    $FullcountExit = $LASTEXITCODE

    "[$(Get-Date -Format o)] Running validated Studio D'Artisan 8173 L/white monitor" |
        Out-File -FilePath $RunLogPath -Append -Encoding utf8
    & node '.\local\studio-single-runner.mjs' '8173' *>> $RunLogPath
    $Studio8173Exit = $LASTEXITCODE

    "[$(Get-Date -Format o)] Running validated Studio D'Artisan 8186 M monitor" |
        Out-File -FilePath $RunLogPath -Append -Encoding utf8
    & node '.\local\studio-single-runner.mjs' '8186' *>> $RunLogPath
    $Studio8186Exit = $LASTEXITCODE

    "[$(Get-Date -Format o)] Merging the three fresh results" |
        Out-File -FilePath $RunLogPath -Append -Encoding utf8
    & node '.\local\merge-three-watch-results.mjs' *>> $RunLogPath
    $MergeExit = $LASTEXITCODE

    $ExitCode = if (
        ($FullcountExit -eq 0) -and
        ($Studio8173Exit -eq 0) -and
        ($Studio8186Exit -eq 0) -and
        ($MergeExit -eq 0)
    ) { 0 } else { 1 }

    "[$(Get-Date -Format o)] Step exits: Fullcount=$FullcountExit, 8173=$Studio8173Exit, 8186=$Studio8186Exit, merge=$MergeExit" |
        Out-File -FilePath $RunLogPath -Append -Encoding utf8
}
catch {
    $_ | Out-String | Out-File -FilePath $RunLogPath -Append -Encoding utf8
    $ExitCode = 1
}
finally {
    Remove-Item Env:RAKUTEN_KEEP_ITEM -ErrorAction SilentlyContinue

    "[$(Get-Date -Format o)] Validated three-watch run exited with code $ExitCode" |
        Out-File -FilePath $RunLogPath -Append -Encoding utf8

    try {
        Get-Content $RunLogPath -Raw |
            Set-Content -Path $LatestLogPath -Encoding utf8
    }
    catch {
        Write-Warning "Could not refresh $LatestLogPath. The completed run log is $RunLogPath"
    }

    if ($HasMutex) {
        try { $Mutex.ReleaseMutex() } catch {}
    }
    $Mutex.Dispose()
}

exit $ExitCode
