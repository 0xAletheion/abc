$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$LogDirectory = Join-Path $Root 'artifacts-local'
New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
$LogPath = Join-Path $LogDirectory 'scheduled-task.log'

"`n[$(Get-Date -Format o)] Starting local Rakuten monitor" | Out-File -FilePath $LogPath -Append -Encoding utf8

try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start-chrome.ps1') -Minimized *>> $LogPath
    if ($LASTEXITCODE -ne 0) {
        throw "Dedicated Chrome startup failed with exit code $LASTEXITCODE."
    }

    & node '.\local\local-monitor-cdp.mjs' *>> $LogPath
    $ExitCode = $LASTEXITCODE
}
catch {
    $_ | Out-String | Out-File -FilePath $LogPath -Append -Encoding utf8
    $ExitCode = 1
}

"[$(Get-Date -Format o)] Monitor exited with code $ExitCode" | Out-File -FilePath $LogPath -Append -Encoding utf8
exit $ExitCode
