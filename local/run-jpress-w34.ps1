# Standalone J. Press W34 check; does not launch Chrome or run Rakuten tasks.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$ArtifactDir = Join-Path $Root 'artifacts-local'
$ResultPath = Join-Path $ArtifactDir 'jpress-w34-result.json'
$LogPath = Join-Path $ArtifactDir 'jpress-w34-run.log'
New-Item -Path $ArtifactDir -ItemType Directory -Force | Out-Null
Set-Location $Root

function Write-WatchLog {
    param([string]$Message)
    ('[{0}] {1}' -f (Get-Date -Format o), $Message) |
        Out-File -FilePath $LogPath -Append -Encoding utf8
}

try {
    $NodeExe = (Get-Command node.exe -ErrorAction Stop).Source
    Write-WatchLog 'Starting J. Press Trim W34 variant check'
    & $NodeExe (Join-Path $PSScriptRoot 'jpress-w34-watch.mjs')
    $NodeExit = [int]$LASTEXITCODE

    if (-not (Test-Path $ResultPath)) {
        Write-WatchLog 'ERROR: expected JSON result file was not created'
        exit 1
    }

    $Result = Get-Content -Path $ResultPath -Raw | ConvertFrom-Json
    Write-WatchLog ('Status={0}, available={1}, alert={2}, nodeExit={3}, error={4}' -f
        $Result.status, $Result.variant_available, $Result.alert_triggered,
        $NodeExit, $Result.error)

    if ($Result.notification_pending -eq $true) {
        Write-WatchLog 'W34 AVAILABLE and unacknowledged: launching persistent alert window'
        try {
            $AlertScript = Join-Path $PSScriptRoot 'jpress-w34-alert-window.ps1'
            if (-not (Test-Path $AlertScript)) {
                throw "Alert window script is missing: $AlertScript"
            }
            # Launch independently: the scheduler task can complete normally while
            # the user's visible alert stays open for as long as necessary.
            $AlertArguments = '-NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $AlertScript
            Start-Process -FilePath 'powershell.exe' -ArgumentList $AlertArguments | Out-Null
            Write-WatchLog 'Persistent restock alert process started (desktop visibility requires an interactive session)'
        }
        catch {
            Write-WatchLog ('Persistent Windows alert could not be started: ' + $_.Exception.Message)
        }
        Write-Host 'J. Press W34 AVAILABLE and unacknowledged. See artifacts-local\jpress-w34-alert.txt.'
    }

    exit $NodeExit
}
catch {
    Write-WatchLog ('ERROR: ' + $_.Exception.Message)
    Write-Error $_
    exit 1
}
