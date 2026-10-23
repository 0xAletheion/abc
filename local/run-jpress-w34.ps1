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
        $Result.status, $Result.genuinely_available, $Result.alert_triggered,
        $NodeExit, $Result.error)

    if ($Result.alert_triggered -eq $true) {
        Write-WatchLog 'W34 AVAILABLE: attempting Windows notification'
        try {
            Add-Type -AssemblyName System.Windows.Forms
            Add-Type -AssemblyName System.Drawing
            $Notice = New-Object System.Windows.Forms.NotifyIcon
            try {
                $Notice.Icon = [System.Drawing.SystemIcons]::Information
                $Notice.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
                $Notice.BalloonTipTitle = 'J. Press Trim W34 in stock'
                $Notice.BalloonTipText = 'J. Press Ivy Essential Khaki Chino, Trim W34: check the website now.'
                $Notice.Visible = $true
                [System.Media.SystemSounds]::Exclamation.Play()
                $Notice.ShowBalloonTip(10000)
                Start-Sleep -Seconds 12
            }
            finally {
                $Notice.Dispose()
            }
        }
        catch {
            Write-WatchLog ('Windows notification unavailable: ' + $_.Exception.Message)
        }
        Write-Host 'J. Press W34 AVAILABLE. See artifacts-local\jpress-w34-alert.txt.'
    }
    exit $NodeExit
}
catch {
    Write-WatchLog ('ERROR: ' + $_.Exception.Message)
    Write-Error $_
    exit 1
}
