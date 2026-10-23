# Create a NEW, separate twice-daily Windows task. Does not touch the Rakuten watch.
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Runner = Join-Path $PSScriptRoot 'run-jpress-w34.ps1'
$TaskName = 'JPress Ivy Khaki Trim W34 Watch'

if (-not (Test-Path $Runner)) { throw 'Missing local\run-jpress-w34.ps1' }
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    throw 'Node.js is not available on PATH. Install Node.js before scheduling.'
}

$Action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $Runner) -WorkingDirectory $Root
$Morning = New-ScheduledTaskTrigger -Daily -At '10:30AM'
$Evening = New-ScheduledTaskTrigger -Daily -At '10:30PM'
$Principal = New-ScheduledTaskPrincipal -UserId ('{0}\{1}' -f $env:USERDOMAIN, $env:USERNAME) -LogonType Interactive -RunLevel Limited
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3)

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger @($Morning, $Evening) -Principal $Principal -Settings $Settings -Force | Out-Null

Write-Host "Installed: $TaskName"
Write-Host 'Scheduled at 10:30 and 22:30 Windows local time, every day.'
Write-Host 'Rakuten task unchanged.'
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
