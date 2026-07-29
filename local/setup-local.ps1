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
    Write-Host 'Starting ordinary Chrome with the dedicated Rakuten profile.'
    Write-Host 'Running a visible test of all three watches and retaining any verified item.'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'run-local.ps1') -KeepItem
    $FirstRunExit = $LASTEXITCODE
    if ($FirstRunExit -ne 0) {
        Write-Warning 'The visible multi-watch test did not complete successfully. Inspect artifacts-local\result.json and scheduled-task.log.'
    }
    else {
        Write-Host 'Visible test completed. Manually delete any item retained in the dedicated Rakuten basket.'
    }
}

if (-not $SkipSchedule) {
    $TaskName = 'Rakuten Fullcount 1110 W33 Watch'
    $RunScript = Join-Path $PSScriptRoot 'run-local.ps1'
    $Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$RunScript`""
    $Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $Arguments -WorkingDirectory $Root
    $StartAt = (Get-Date).AddMinutes(5)
    $Trigger = New-ScheduledTaskTrigger -Once -At $StartAt -RepetitionInterval (New-TimeSpan -Hours 12) -RepetitionDuration (New-TimeSpan -Days 3650)
    $Principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    $Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)

    Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
    Write-Host "Installed twice-daily Windows task: $TaskName"
    Write-Host 'The task checks Fullcount 1110 W33, Studio D''Artisan 8173 white L, and Studio D''Artisan 8186 M.'
    Write-Host 'Background runs remove their own verified basket items to prevent accumulation.'
}

Write-Host ''
Write-Host 'Setup complete.'
Write-Host 'Latest result: artifacts-local\result.json'
Write-Host 'Run log:      artifacts-local\scheduled-task.log'
Write-Host 'State file:   artifacts-local\watch-state.json'
