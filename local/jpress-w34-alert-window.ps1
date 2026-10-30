# Persistent, independent acknowledgement window for the J. Press W34 monitor.
# An acknowledgement is stored separately from the monitoring state, so a
# monitored restock is not silenced until the user explicitly acknowledges it.
# -Test previews the window without modifying the acknowledgement state.
param([switch]$Test)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Artifacts = Join-Path $Root 'artifacts-local'
$ResultPath = Join-Path $Artifacts 'jpress-w34-result.json'
$AckPath = Join-Path $Artifacts 'jpress-w34-ack.json'
$LogPath = Join-Path $Artifacts 'jpress-w34-alert-ui.log'
$ExpectedVariant = '43871276138543'
$ProductUrl = 'https://jpress.com/products/khaki-unwashed-cotton-chino-trim-fit?variant=43871276138543'

New-Item -ItemType Directory -Path $Artifacts -Force | Out-Null

function Write-AlertLog {
    param([string]$Message)
    ('[{0}] {1}' -f (Get-Date -Format o), $Message) |
        Out-File -FilePath $LogPath -Encoding utf8 -Append
}

$Mutex = $null
$OwnsMutex = $false
try {
    # Only one real window can stay open, even after repeated scheduled checks.
    # A separate mutex lets an intentional -Test preview run alongside it.
    $MutexName = if ($Test) { 'Local\JPressW34RestockAlertTest' } else { 'Local\JPressW34RestockAlert' }
    $Mutex = New-Object System.Threading.Mutex($false, $MutexName)
    try {
        $OwnsMutex = $Mutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        $OwnsMutex = $true
    }
    if (-not $OwnsMutex) {
        Write-AlertLog 'A J. Press alert window is already open; skipping duplicate.'
        return
    }

    if (-not $Test) {
        if (-not (Test-Path $ResultPath)) {
            Write-AlertLog 'No result file: window not displayed.'
            return
        }
        $Result = Get-Content -Path $ResultPath -Raw | ConvertFrom-Json
        if (
            [string]$Result.variant_id -ne $ExpectedVariant -or
            $Result.status -ne 'available' -or
            $Result.variant_available -ne $true
        ) {
            Write-AlertLog 'Latest result does not confirm W34 availability; window not displayed.'
            return
        }

        if (Test-Path $AckPath) {
            try {
                $Ack = Get-Content $AckPath -Raw | ConvertFrom-Json
                if ($Ack.acknowledged -eq $true -and [string]$Ack.variant_id -eq $ExpectedVariant) {
                    Write-AlertLog 'Restock already acknowledged; window not displayed.'
                    return
                }
            } catch {
                Write-AlertLog ('Acknowledgement unreadable; will show alert: ' + $_.Exception.Message)
            }
        }
    }

    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    [System.Windows.Forms.Application]::EnableVisualStyles()

    $Form = New-Object System.Windows.Forms.Form
    $Form.Text = if ($Test) { 'TEST - J. Press W34 restock alert' } else { 'J. Press W34 is available' }
    $Form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $Form.Size = New-Object System.Drawing.Size(540, 270)
    $Form.MinimumSize = $Form.Size
    $Form.MaximumSize = $Form.Size
    $Form.TopMost = $true
    $Form.ShowInTaskbar = $true
    $Form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
    $Form.MaximizeBox = $false

    $Title = New-Object System.Windows.Forms.Label
    $Title.Text = if ($Test) { 'TEST ALERT - J. Press Trim Fit W34' } else { 'J. Press Trim Fit W34 is in stock' }
    $Title.Font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
    $Title.AutoSize = $false
    $Title.SetBounds(22, 18, 490, 34)
    $Form.Controls.Add($Title)

    $Detail = New-Object System.Windows.Forms.Label
    $Detail.Text = if ($Test) {
        'This is a preview. Acknowledging it will not change the stock-watch settings.'
    } else {
        'The exact khaki twill Trim Fit size W34 is marked available. Confirm stock at checkout.'
    }
    $Detail.AutoSize = $false
    $Detail.SetBounds(22, 61, 488, 51)
    $Detail.Font = New-Object System.Drawing.Font('Segoe UI', 10)
    $Form.Controls.Add($Detail)

    $Reminder = New-Object System.Windows.Forms.Label
    $Reminder.Text = if ($Test) {
        'This test window stays open until you close it.'
    } else {
        'This window stays open. Close or defer it to be reminded at the next scheduled check.'
    }
    $Reminder.AutoSize = $false
    $Reminder.SetBounds(22, 113, 488, 40)
    $Reminder.Font = New-Object System.Drawing.Font('Segoe UI', 9)
    $Form.Controls.Add($Reminder)

    $OpenButton = New-Object System.Windows.Forms.Button
    $OpenButton.Text = 'Open J. Press'
    $OpenButton.SetBounds(20, 174, 145, 38)
    $OpenButton.Add_Click({
        try {
            Start-Process -FilePath $ProductUrl | Out-Null
        } catch {
            Write-AlertLog ('Could not open browser: ' + $_.Exception.Message)
        }
    })
    $Form.Controls.Add($OpenButton)

    $LaterButton = New-Object System.Windows.Forms.Button
    $LaterButton.Text = 'Remind later'
    $LaterButton.SetBounds(181, 174, 145, 38)
    $LaterButton.Add_Click({
        Write-AlertLog 'User deferred the restock alert.'
        $Form.Close()
    })
    $Form.Controls.Add($LaterButton)

    $AckButton = New-Object System.Windows.Forms.Button
    $AckButton.Text = if ($Test) { 'Close test' } else { 'Acknowledge'
    }
    $AckButton.SetBounds(342, 174, 162, 38)
    $AckButton.Add_Click({
        if (-not $Test) {
            try {
                $Record = @{
                    variant_id = $ExpectedVariant
                    acknowledged = $true
                    acknowledged_at = (Get-Date).ToUniversalTime().ToString('o')
                } | ConvertTo-Json
                $Utf8 = New-Object System.Text.UTF8Encoding($false)
                [System.IO.File]::WriteAllText($AckPath, $Record, $Utf8)
                Write-AlertLog 'User acknowledged the J. Press W34 restock.'
            } catch {
                Write-AlertLog ('Acknowledgement could not be saved: ' + $_.Exception.Message)
                [System.Windows.Forms.MessageBox]::Show(
                    'Could not save your acknowledgement. The watch will remind you again.',
                    'J. Press W34'
                ) | Out-Null
                return
            }
        }
        $Form.Close()
    })
    $Form.Controls.Add($AckButton)

    $Form.Add_Shown({
        $Form.Activate()
        [System.Media.SystemSounds]::Exclamation.Play()
    })
    Write-AlertLog $(if ($Test) { 'Opened test alert window.' } else { 'Opened persistent restock alert window.' })
    [System.Windows.Forms.Application]::Run($Form)
}
catch {
    Write-AlertLog ('Alert window failed: ' + $_.Exception.Message)
    throw
}
finally {
    if ($OwnsMutex -and $null -ne $Mutex) {
        try { $Mutex.ReleaseMutex() } catch {}
    }
    if ($null -ne $Mutex) { $Mutex.Dispose() }
}
