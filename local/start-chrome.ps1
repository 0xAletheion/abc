param(
    [switch]$Minimized,
    [string]$ProductUrl = 'https://item.rakuten.co.jp/realmoon/1110w/'
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$ProfileDir = Join-Path $Root '.rakuten-cdp-profile'
$Port = 9222
$Endpoint = "http://127.0.0.1:$Port/json/version"

function Test-DebugEndpoint {
    try {
        $response = Invoke-RestMethod -Uri $Endpoint -TimeoutSec 2
        return [bool]$response.webSocketDebuggerUrl
    }
    catch {
        return $false
    }
}

if (Test-DebugEndpoint) {
    Write-Host "Dedicated Chrome is already available on port $Port."
    exit 0
}

$ChromePaths = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$Chrome = $ChromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $Chrome) {
    throw 'Google Chrome was not found.'
}

New-Item -ItemType Directory -Force -Path $ProfileDir | Out-Null

$ChromeArguments = @(
    "--remote-debugging-port=$Port",
    '--remote-debugging-address=127.0.0.1',
    "--user-data-dir=$ProfileDir",
    '--no-first-run',
    '--no-default-browser-check',
    $ProductUrl
)

$WindowStyle = if ($Minimized) { 'Minimized' } else { 'Normal' }
Start-Process -FilePath $Chrome -ArgumentList $ChromeArguments -WindowStyle $WindowStyle | Out-Null

$Deadline = (Get-Date).AddSeconds(20)
do {
    Start-Sleep -Milliseconds 500
    if (Test-DebugEndpoint) {
        Write-Host "Ordinary Chrome started with the dedicated Rakuten profile on port $Port."
        exit 0
    }
} while ((Get-Date) -lt $Deadline)

throw "Chrome started, but its local debugging endpoint did not become available at $Endpoint."
