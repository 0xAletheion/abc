param(
    [switch]$KeepItem
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$LogDirectory = Join-Path $Root 'artifacts-local'
New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null
$LogPath = Join-Path $LogDirectory 'scheduled-task.log'

"`n[$(Get-Date -Format o)] Starting local Rakuten three-watch run" | Out-File -FilePath $LogPath -Append -Encoding utf8

try {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start-chrome.ps1') -Minimized *>> $LogPath
    if ($LASTEXITCODE -ne 0) {
        throw "Dedicated Chrome startup failed with exit code $LASTEXITCODE."
    }

    if ($KeepItem) {
        $env:RAKUTEN_KEEP_ITEM = '1'
    } else {
        Remove-Item Env:RAKUTEN_KEEP_ITEM -ErrorAction SilentlyContinue
    }

    "[$(Get-Date -Format o)] Running proven Fullcount 1110 W33 monitor" | Out-File -FilePath $LogPath -Append -Encoding utf8
    & node '.\local\local-monitor-runner.mjs' *>> $LogPath
    $FullcountExit = $LASTEXITCODE

    "[$(Get-Date -Format o)] Running dedicated Studio D'Artisan monitors" | Out-File -FilePath $LogPath -Append -Encoding utf8
    & node '.\local\studio-dartisan-watch.mjs' *>> $LogPath
    $StudioExit = $LASTEXITCODE

    $ExitCode = if (($FullcountExit -eq 0) -and ($StudioExit -eq 0)) { 0 } else { 1 }
}
catch {
    $_ | Out-String | Out-File -FilePath $LogPath -Append -Encoding utf8
    $ExitCode = 1
}
finally {
    Remove-Item Env:RAKUTEN_KEEP_ITEM -ErrorAction SilentlyContinue
}

"[$(Get-Date -Format o)] Three-watch run exited with code $ExitCode" | Out-File -FilePath $LogPath -Append -Encoding utf8
exit $ExitCode
