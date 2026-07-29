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
        [int]$TimeoutSeconds = 480
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

    ("[{0}] Step exited with code {1}: {2}" -f (Get-Date -Format o), $StepExit, $Label) |
        Out-File -FilePath $RunLogPath -Append -Encoding utf8

    return $StepExit
}

function New-PowerShellArguments {
    param(
        [string]$ScriptPath,
        [string[]]$ExtraArguments = @()
    )

    $Arguments = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $ScriptPath
    )
    $Arguments += $ExtraArguments
    if ($KeepItem) {
        $Arguments += '-KeepItem'
    }
    return $Arguments
}

try {
    $HasMutex = $Mutex.WaitOne(0)
    if (-not $HasMutex) {
        "[$(Get-Date -Format o)] Another validated three-watch run is already active; this invocation was skipped." |
            Set-Content -Path $LatestLogPath -Encoding utf8
        $ExitCode = 0
        return
    }

    $StartMessage = "[$(Get-Date -Format o)] Starting validated Rakuten three-watch run using independently proven wrappers"
    $StartMessage | Set-Content -Path $RunLogPath -Encoding utf8
    $StartMessage | Set-Content -Path $LatestLogPath -Encoding utf8

    # Stop only stale monitor Node processes. Chrome itself is deliberately left to
    # each validated wrapper, which will reuse or restart the CDP browser as needed.
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -eq 'node.exe' -and
            $_.CommandLine -match 'local-monitor-runner|local-monitor-cdp|studio-single-runner|studio-dartisan-watch|\.studio-(8173|8186)-runtime'
        } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }

    Start-Sleep -Milliseconds 750

    # Preflight every generator and generated runtime before any browser stage.
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

    # Use the exact wrappers that passed in isolation. Each wrapper independently
    # ensures the dedicated Chrome/CDP endpoint exists before running its watch.
    $FullcountArguments = New-PowerShellArguments `
        -ScriptPath (Join-Path $PSScriptRoot 'run-fullcount-only.ps1')
    $FullcountExit = Invoke-CapturedProcess `
        -Label 'validated-fullcount-1110w-w33-wrapper' `
        -FilePath $PowerShellExe `
        -Arguments $FullcountArguments `
        -TimeoutSeconds 600

    Start-Sleep -Seconds 1

    $Studio8173Arguments = New-PowerShellArguments `
        -ScriptPath (Join-Path $PSScriptRoot 'run-studio-only.ps1') `
        -ExtraArguments @('-Watch', '8173')
    $Studio8173Exit = Invoke-CapturedProcess `
        -Label 'validated-studio-8173-l-white-wrapper' `
        -FilePath $PowerShellExe `
        -Arguments $Studio8173Arguments `
        -TimeoutSeconds 600

    Start-Sleep -Seconds 1

    $Studio8186Arguments = New-PowerShellArguments `
        -ScriptPath (Join-Path $PSScriptRoot 'run-studio-only.ps1') `
        -ExtraArguments @('-Watch', '8186')
    $Studio8186Exit = Invoke-CapturedProcess `
        -Label 'validated-studio-8186-m-wrapper' `
        -FilePath $PowerShellExe `
        -Arguments $Studio8186Arguments `
        -TimeoutSeconds 600

    # Always merge, even when a stage failed. The resilient merger will publish a
    # structured row for every watch so the failure is inspectable.
    $MergeExit = Invoke-CapturedProcess `
        -Label 'merge-three-watch-results' `
        -FilePath $NodeExe `
        -Arguments @((Join-Path $PSScriptRoot 'merge-three-watch-results.mjs'))

    if (-not (Test-Path '.\artifacts-local\three-watch-result.json')) {
        "[$(Get-Date -Format o)] Merger returned code $MergeExit but three-watch-result.json was not created." |
            Out-File -FilePath $RunLogPath -Append -Encoding utf8
        $MergeExit = 126
    }

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
