param(
    [switch]$KeepItem
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$LogDirectory = Join-Path $Root 'artifacts-local'
New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null

$RunStamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$RunLogPath = Join-Path $LogDirectory ("three-watch-{0}.log" -f $RunStamp)
$LatestLogPath = Join-Path $LogDirectory 'scheduled-task.log'
$NodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$PowerShellExe = (Get-Command powershell.exe -ErrorAction Stop).Source

$Mutex = New-Object System.Threading.Mutex($false, 'RakutenThreeWatchValidated')
$HasMutex = $false
$ExitCode = 1

function Add-StepOutput {
    param(
        [string]$Path,
        [string]$Heading
    )

    if (Test-Path $Path) {
        $Text = Get-Content $Path -Raw -ErrorAction SilentlyContinue
        if ($Text) {
            "--- $Heading ---" | Out-File -FilePath $RunLogPath -Append -Encoding utf8
            $Text | Out-File -FilePath $RunLogPath -Append -Encoding utf8
        }
    }
}

function Invoke-CapturedProcess {
    param(
        [string]$Label,
        [string]$FilePath,
        [string[]]$Arguments,
        [int]$TimeoutSeconds = 360
    )

    $SafeLabel = $Label -replace '[^A-Za-z0-9_-]', '-'
    $StdoutPath = Join-Path $LogDirectory ("{0}-{1}.stdout.log" -f $RunStamp, $SafeLabel)
    $StderrPath = Join-Path $LogDirectory ("{0}-{1}.stderr.log" -f $RunStamp, $SafeLabel)

    "[$(Get-Date -Format o)] Starting step: $Label" |
        Out-File -FilePath $RunLogPath -Append -Encoding utf8

    try {
        $Process = Start-Process `
            -FilePath $FilePath `
            -ArgumentList $Arguments `
            -PassThru `
            -NoNewWindow `
            -RedirectStandardOutput $StdoutPath `
            -RedirectStandardError $StderrPath

        $Finished = $Process.WaitForExit($TimeoutSeconds * 1000)
        if (-not $Finished) {
            try { Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue } catch {}
            $StepExit = 124
            "[$(Get-Date -Format o)] Step timed out after $TimeoutSeconds seconds: $Label" |
                Out-File -FilePath $RunLogPath -Append -Encoding utf8
        }
        else {
            $Process.WaitForExit()
            $StepExit = [int]$Process.ExitCode
        }
    }
    catch {
        $_ | Out-String | Out-File -FilePath $StderrPath -Encoding utf8
        $StepExit = 125
    }

    Add-StepOutput -Path $StdoutPath -Heading "$Label stdout"
    Add-StepOutput -Path $StderrPath -Heading "$Label stderr"

    "[$(Get-Date -Format o)] Step exited with code ${StepExit}: $Label" |
        Out-File -FilePath $RunLogPath -Append -Encoding utf8

    return $StepExit
}

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

    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -eq 'node.exe' -and
            $_.CommandLine -match 'studio-single-runner|studio-dartisan-watch|\.studio-(8173|8186)-runtime'
        } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }

    Start-Sleep -Milliseconds 750

    if ($KeepItem) {
        $env:RAKUTEN_KEEP_ITEM = '1'
    }
    else {
        Remove-Item Env:RAKUTEN_KEEP_ITEM -ErrorAction SilentlyContinue
    }

    # Build and syntax-check every validated runtime before touching the basket.
    # This prevents a later generator error from leaving Chrome on Fullcount's
    # post-cleanup empty-cart page with no Studio stages attempted.
    $env:RAKUTEN_PATCH_ONLY = '1'
    $GenerateFullcount = Invoke-CapturedProcess `
        -Label 'preflight-generate-fullcount' `
        -FilePath $NodeExe `
        -Arguments @((Join-Path $PSScriptRoot 'local-monitor-runner.mjs'))
    $Generate8173 = Invoke-CapturedProcess `
        -Label 'preflight-generate-8173' `
        -FilePath $NodeExe `
        -Arguments @((Join-Path $PSScriptRoot 'studio-single-runner.mjs'), '8173')
    $Generate8186 = Invoke-CapturedProcess `
        -Label 'preflight-generate-8186' `
        -FilePath $NodeExe `
        -Arguments @((Join-Path $PSScriptRoot 'studio-single-runner.mjs'), '8186')
    Remove-Item Env:RAKUTEN_PATCH_ONLY -ErrorAction SilentlyContinue

    $CheckFullcount = Invoke-CapturedProcess `
        -Label 'preflight-check-fullcount' `
        -FilePath $NodeExe `
        -Arguments @('--check', (Join-Path $PSScriptRoot '.local-monitor-cdp-v2-runtime.mjs'))
    $Check8173 = Invoke-CapturedProcess `
        -Label 'preflight-check-8173' `
        -FilePath $NodeExe `
        -Arguments @('--check', (Join-Path $PSScriptRoot '.studio-8173-runtime.mjs'))
    $Check8186 = Invoke-CapturedProcess `
        -Label 'preflight-check-8186' `
        -FilePath $NodeExe `
        -Arguments @('--check', (Join-Path $PSScriptRoot '.studio-8186-runtime.mjs'))

    $PreflightCodes = @(
        $GenerateFullcount, $Generate8173, $Generate8186,
        $CheckFullcount, $Check8173, $Check8186
    )
    if ($PreflightCodes | Where-Object { $_ -ne 0 }) {
        throw "Runtime preflight failed. Codes: $($PreflightCodes -join ', ')."
    }

    Remove-Item '.\artifacts-local\result.json' -Force -ErrorAction SilentlyContinue
    Remove-Item '.\artifacts-local\studio-8173-result.json' -Force -ErrorAction SilentlyContinue
    Remove-Item '.\artifacts-local\studio-8186-result.json' -Force -ErrorAction SilentlyContinue
    Remove-Item '.\artifacts-local\three-watch-result.json' -Force -ErrorAction SilentlyContinue

    $ChromeExit = Invoke-CapturedProcess `
        -Label 'start-dedicated-chrome' `
        -FilePath $PowerShellExe `
        -Arguments @(
            '-NoProfile', '-ExecutionPolicy', 'Bypass',
            '-File', (Join-Path $PSScriptRoot 'start-chrome.ps1'),
            '-Minimized',
            '-ProductUrl', 'https://item.rakuten.co.jp/realmoon/1110w/'
        ) `
        -TimeoutSeconds 60

    if ($ChromeExit -ne 0) {
        throw "Dedicated Chrome startup failed with exit code $ChromeExit."
    }

    $FullcountExit = Invoke-CapturedProcess `
        -Label 'validated-fullcount-1110w-w33' `
        -FilePath $NodeExe `
        -Arguments @((Join-Path $PSScriptRoot '.local-monitor-cdp-v2-runtime.mjs'))

    $Studio8173Exit = Invoke-CapturedProcess `
        -Label 'validated-studio-8173-l-white' `
        -FilePath $NodeExe `
        -Arguments @((Join-Path $PSScriptRoot '.studio-8173-runtime.mjs'))

    $Studio8186Exit = Invoke-CapturedProcess `
        -Label 'validated-studio-8186-m' `
        -FilePath $NodeExe `
        -Arguments @((Join-Path $PSScriptRoot '.studio-8186-runtime.mjs'))

    # Always attempt the merge. The merger creates a structured combined result
    # even when one of the three stage files is missing or contains an error.
    $MergeExit = Invoke-CapturedProcess `
        -Label 'merge-three-watch-results' `
        -FilePath $NodeExe `
        -Arguments @((Join-Path $PSScriptRoot 'merge-three-watch-results.mjs'))

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

    # A preflight or Chrome-start failure occurs before normal stage output.
    # Still ask the resilient merger to publish an inspectable combined result.
    try {
        Invoke-CapturedProcess `
            -Label 'merge-after-wrapper-error' `
            -FilePath $NodeExe `
            -Arguments @((Join-Path $PSScriptRoot 'merge-three-watch-results.mjs')) | Out-Null
    }
    catch {}

    $ExitCode = 1
}
finally {
    Remove-Item Env:RAKUTEN_PATCH_ONLY -ErrorAction SilentlyContinue
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
