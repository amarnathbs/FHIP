$ErrorActionPreference = 'Stop'
Set-Location D:\FHIP\.claude\worktrees\agent-a8ad709cd64e17988
$secretFile = 'test-artifacts\nav2_stage3\.cron_secret'
if (-not (Test-Path $secretFile)) { [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N') | Set-Content -NoNewline $secretFile }
$env:CRON_SECRET = (Get-Content $secretFile -Raw).Trim()
Start-Process -FilePath node -ArgumentList 'scripts/canonical_cert/dev_server.mjs', '--port', '3981' -RedirectStandardOutput test-artifacts\nav2_stage3_devserver.log -RedirectStandardError test-artifacts\nav2_stage3_devserver.err -WindowStyle Hidden
