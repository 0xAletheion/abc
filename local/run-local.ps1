param(
    [switch]$Headless
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if ($Headless) {
    $env:RAKUTEN_HEADLESS = '1'
} else {
    $env:RAKUTEN_HEADLESS = '0'
}

$LogDirectory = Join-Path $Root 'artifacts-local'
New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
$LogPath = Join-Path $LogDirectory 'scheduled-task.log'

"`n[$(Get-Date -Format o)] Starting local Rakuten monitor" | Out-File -FilePath $LogPath -Append -Encoding utf8
& node '.\local\local-monitor.mjs' *>> $LogPath
$ExitCode = $LASTEXITCODE
"[$(Get-Date -Format o)] Monitor exited with code $ExitCode" | Out-File -FilePath $LogPath -Append -Encoding utf8
exit $ExitCode
