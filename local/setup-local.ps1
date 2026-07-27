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

$ChromePaths = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
if (-not ($ChromePaths | Where-Object { Test-Path $_ })) {
    throw 'Google Chrome was not found. Install Chrome before running the local monitor.'
}

Write-Host 'Installing Node dependencies...'
npm install

if (-not $SkipBootstrap) {
    Write-Host ''
    Write-Host 'Opening a dedicated Chrome profile for a one-time manual basket check.'
    Write-Host 'This does not use or modify your normal Chrome profile.'
    node '.\local\local-monitor.mjs' --bootstrap
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
    Write-Host 'It runs only while you are logged into Windows and uses a dedicated Chrome profile.'
}

Write-Host ''
Write-Host 'Setup complete.'
Write-Host 'Latest result: artifacts-local\result.json'
Write-Host 'Run log:      artifacts-local\scheduled-task.log'
