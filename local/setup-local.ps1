param(
    [switch]$SkipBootstrap,
    [switch]$SkipSchedule
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js is not installed or is not on PATH. Install the current Node.js LTS release first.'
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'npm is not installed or is not on PATH.'
}

Write-Host 'Installing Node dependencies...'
npm install

if (-not $SkipBootstrap) {
    Write-Host ''
    Write-Host 'Starting ordinary Chrome with a fresh dedicated Rakuten profile.'
    Write-Host 'Chrome is launched directly by PowerShell, without Playwright launch flags or --no-sandbox.'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'start-chrome.ps1')
    if ($LASTEXITCODE -ne 0) {
        throw 'The dedicated ordinary Chrome session could not be started.'
    }

    node '.\local\local-monitor-cdp.mjs' --bootstrap
    if ($LASTEXITCODE -ne 0) {
        throw 'The bootstrap browser check did not complete successfully. Review artifacts-local\result.json.'
    }
}

Write-Host ''
Write-Host 'Running the first automated local basket test...'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'run-local.ps1')
$FirstRunExit = $LASTEXITCODE
if ($FirstRunExit -ne 0) {
    Write-Warning 'The first automated run did not complete successfully. The task can still be installed, but inspect artifacts-local\result.json first.'
}

if (-not $SkipSchedule) {
    $TaskName = 'Rakuten Fullcount 1110 W33 Watch'
    $RunScript = Join-Path $PSScriptRoot 'run-local.ps1'
    $Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$RunScript`""
    $Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $Arguments -WorkingDirectory $Root
    $StartAt = (Get-Date).AddMinutes(5)
    $Trigger = New-ScheduledTaskTrigger -Once -At $StartAt -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
    $Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    $Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 12)

    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
    Write-Host "Installed hourly Windows task: $TaskName"
    Write-Host 'It runs only while you are logged into Windows and uses an ordinary Chrome session with a dedicated profile.'
}

Write-Host ''
Write-Host 'Setup complete.'
Write-Host 'Latest result: artifacts-local\result.json'
Write-Host 'Run log:      artifacts-local\scheduled-task.log'
