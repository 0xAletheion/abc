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
$LogPath = Join-Path $LogDirectory ("studio-{0}-only.log" -f $Watch)

"`n[$(Get-Date -Format o)] Starting isolated Studio D'Artisan $Watch run" |
    Out-File -FilePath $LogPath -Append -Encoding utf8

try {
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

    & node '.\local\studio-single-runner.mjs' $Watch *>> $LogPath
    $ExitCode = $LASTEXITCODE
}
catch {
    $_ | Out-String | Out-File -FilePath $LogPath -Append -Encoding utf8
    $ExitCode = 1
}
finally {
    Remove-Item Env:RAKUTEN_KEEP_ITEM -ErrorAction SilentlyContinue
}

"[$(Get-Date -Format o)] Studio $Watch-only run exited with code $ExitCode" |
    Out-File -FilePath $LogPath -Append -Encoding utf8

exit $ExitCode
