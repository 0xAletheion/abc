param(
    [switch]$KeepItem
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$ArtifactDir = Join-Path $Root 'artifacts-local'
$LogPath = Join-Path $ArtifactDir 'scheduled-task.log'
$PowerShellExe = (Get-Command powershell.exe -ErrorAction Stop).Source
$NodeExe = (Get-Command node.exe -ErrorAction Stop).Source

New-Item -ItemType Directory -Force -Path $ArtifactDir | Out-Null

function Write-RunLog {
    param([string]$Message)

    "[$(Get-Date -Format o)] $Message" |
        Out-File -FilePath $LogPath -Append -Encoding utf8
}

function Stop-DedicatedRakutenChrome {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -eq 'chrome.exe' -and
            $_.CommandLine -match '(?:remote-debugging-port=9222|\.rakuten-cdp-profile)'
        } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }

    Start-Sleep -Seconds 2
}

function Run-Wrapper {
    param(
        [string]$Label,
        [string]$ScriptPath,
        [string[]]$ExtraArguments = @()
    )

    Write-RunLog "Starting $Label"
    Stop-DedicatedRakutenChrome

    $Arguments = @(
        '-NoProfile',
        '-ExecutionPolicy', 'Bypass',
        '-File', $ScriptPath
    )
    $Arguments += $ExtraArguments
    if ($KeepItem) {
        $Arguments += '-KeepItem'
    }

    & $PowerShellExe @Arguments
    $Code = $LASTEXITCODE
    Write-RunLog "$Label exited with code $Code"
    return $Code
}

Set-Content -Path $LogPath -Value "[$(Get-Date -Format o)] Starting simple sequential Rakuten three-watch run" -Encoding utf8

Remove-Item '.\artifacts-local\result.json' -Force -ErrorAction SilentlyContinue
Remove-Item '.\artifacts-local\studio-8173-result.json' -Force -ErrorAction SilentlyContinue
Remove-Item '.\artifacts-local\studio-8186-result.json' -Force -ErrorAction SilentlyContinue
Remove-Item '.\artifacts-local\three-watch-result.json' -Force -ErrorAction SilentlyContinue

$FullcountExit = Run-Wrapper `
    -Label 'Fullcount 1110W W33' `
    -ScriptPath (Join-Path $PSScriptRoot 'run-fullcount-only.ps1')

$Studio8173Exit = Run-Wrapper `
    -Label 'Studio 8173 L white' `
    -ScriptPath (Join-Path $PSScriptRoot 'run-studio-only.ps1') `
    -ExtraArguments @('-Watch', '8173')

$Studio8186Exit = Run-Wrapper `
    -Label 'Studio 8186 M' `
    -ScriptPath (Join-Path $PSScriptRoot 'run-studio-only.ps1') `
    -ExtraArguments @('-Watch', '8186')

Stop-DedicatedRakutenChrome

Write-RunLog 'Starting merge'
& $NodeExe (Join-Path $PSScriptRoot 'merge-three-watch-results.mjs')
$MergeExit = $LASTEXITCODE
Write-RunLog "Merge exited with code $MergeExit"

$CombinedExists = Test-Path '.\artifacts-local\three-watch-result.json'
Write-RunLog "Combined file exists: $CombinedExists"
Write-RunLog "Step exits: Fullcount=$FullcountExit, 8173=$Studio8173Exit, 8186=$Studio8186Exit, merge=$MergeExit"

$ExitCode = if (
    ($FullcountExit -eq 0) -and
    ($Studio8173Exit -eq 0) -and
    ($Studio8186Exit -eq 0) -and
    ($MergeExit -eq 0) -and
    $CombinedExists
) { 0 } else { 1 }

Write-RunLog "Simple sequential three-watch run exited with code $ExitCode"
exit $ExitCode
