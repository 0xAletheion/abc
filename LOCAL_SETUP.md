# Local Rakuten Fullcount 1110 W33 monitor

This version runs on your own Windows computer through Google Chrome, using a dedicated persistent browser profile. It does not use your normal Chrome profile and does not require Rakuten credentials.

## What it verifies

1. The live listed price on the Fullcount 1110 product page.
2. ONE WASH and size 33 can be selected.
3. The selected variant can be added to the basket through a normal mouse click.
4. Shopping basket contains FCP-1110W / ONE WASH / SIZE 33.
5. Basket quantity is at least 1.
6. A fixed assumed ¥1,000 discount is applied for the price test.
7. A live GBP/JPY rate is retrieved.
8. A Windows toast appears only when either:
   - listed price is below ¥30,580; or
   - assumed-discount price is below £135.

The verified item is removed from the dedicated monitor basket after each successful check, so hourly runs do not continually increase the quantity.

## Requirements

- Windows 10 or 11
- Google Chrome
- Node.js LTS with npm
- The repository checked out locally

## One-command setup

Open PowerShell in the repository directory and run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\local\setup-local.ps1
```

The setup script will:

1. install the Node dependencies;
2. open a dedicated Chrome profile for a one-time manual basket test;
3. run the first automated local check;
4. install an hourly Windows Task Scheduler task named `Rakuten Fullcount 1110 W33 Watch`.

During the bootstrap browser step, manually select ONE WASH / size 33, add it to the basket, and open Shopping basket. Confirm the correct product appears, then return to PowerShell and press Enter.

## Run it manually

```powershell
.\local\run-local.ps1
```

For a headless experiment:

```powershell
.\local\run-local.ps1 -Headless
```

The scheduled task deliberately uses visible Chrome in a dedicated profile, launched minimised, because that is closer to the browser flow that works manually.

## Evidence and logs

- Latest structured result: `artifacts-local\result.json`
- Run history: `artifacts-local\history.ndjson`
- Scheduled-task log: `artifacts-local\scheduled-task.log`
- Screenshots: `artifacts-local\*.png`

## Remove the hourly task

```powershell
Unregister-ScheduledTask -TaskName 'Rakuten Fullcount 1110 W33 Watch' -Confirm:$false
```

## Reset the dedicated browser profile

Close any monitor Chrome window, then delete:

```text
.rakuten-profile
```

Run `local\setup-local.ps1` again to create a fresh profile.

## Security note

A self-hosted GitHub Actions runner is not used because this repository is public. Running public-repository pull-request workflows on a personal machine would expose that machine to untrusted workflow code. Windows Task Scheduler avoids that risk.
