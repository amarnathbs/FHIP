<#
.SYNOPSIS
  READ-ONLY check of the Amplify environment variables that control AI document reading. Prints NAMES, WHERE each is set, and a value
  ONLY for the plain switches and numbers listed in $ShowValue. Every secret is reported as "set (hidden)" or "missing". Changes nothing.

.DESCRIPTION
  Run it yourself, on your own machine, with your own AWS sign-in (the same one you use for the Amplify console). The engineer who wrote it
  has no production access and has not run it against production.

  What it can and cannot tell you:
   - It reads the Amplify APP-level and BRANCH-level variables. A branch value overrides the app value, so the "effective" source is shown.
   - It CANNOT prove the running server sees a value. A variable reaches the server only if (a) its name matches the forwarding list in
     amplify.yml of the DEPLOYED commit and (b) a build ran after it was set. The "Forwarded" column checks (a) against the list below, which
     must be compared with amplify.yml of the deployed commit (line starting "env | grep -e ..."). The runtime proof is behavioural: journey 1
     of the protocol (a refusal reason names the missing setting; see 01_PRODUCTION_CONFIGURATION.md section 5).

.EXAMPLE
  .\Check-AmplifyAiConfig.ps1 -AppId d1a2b3c4d5e6f7 -Region ap-southeast-2
  (The app id is on the Amplify console, App settings, General. The region is the one shown at the top right of the console.)
#>
param(
  [Parameter(Mandatory = $true)][string]$AppId,
  [string]$Branch = 'main',
  [string]$Region = ''
)
$ErrorActionPreference = 'Stop'

# --- forwarding rule copied from amplify.yml (server-only line). Keep in step with the deployed commit.
$ForwardedTerms = @('SUPABASE_SERVICE_ROLE_KEY', 'CRON_SECRET', 'APP_BASE_URL', 'RESEND_API_KEY', 'CONTACT_FROM_EMAIL', 'PROMO_IP_HASH_SECRET', 'PROMO_CODE_DIGEST_',
  'PROMO_TRUSTED_PROXY_HOPS', 'PREMIUM_REMINDER_', 'PREMIUM_PROMO_EMAIL_', 'G4_APP_CAPABILITY_LAYER_ENABLED', 'G5B_GENERIC_WRITE_ENABLED',
  'G2_LANDING_LOCALISATION_ENABLED', 'G2_ALLOW_TEST_DETECTION_HEADER', 'ROLLOUT_', 'AIE_', 'STRIPE_', 'RAZORPAY_', 'II_AI_FALLBACK_')

# --- variables whose value is a plain switch or number and is safe to print
$ShowValue = @(
  'AIE_AI_FALLBACK_ENABLED', 'II_AI_FALLBACK_ENABLED', 'AIE_PAYSLIP_AI_FALLBACK_ENABLED', 'AIE_BANK_STATEMENT_AI_FALLBACK_ENABLED',
  'AIE_INVESTMENT_STATEMENT_AI_FALLBACK_ENABLED', 'AIE_LIABILITY_AI_FALLBACK_ENABLED', 'AIE_RETIREMENT_STATEMENT_AI_FALLBACK_ENABLED',
  'AIE_REAL_MALWARE_SCAN_ENABLED', 'AIE_AI_PROVIDER', 'AIE_AI_MODEL', 'AIE_AI_COST_ALLOWANCE_USD', 'AIE_USER_DAILY_COST_CAP_USD',
  'AIE_AI_TIMEOUT_MS', 'AIE_AI_MAX_INPUT_TOKENS', 'AIE_AI_MAX_OUTPUT_TOKENS', 'AIE_AI_MAX_OUTPUT_TOKENS_LINE_ITEMS', 'AIE_AI_MAX_TRANSIENT_RETRIES',
  'AIE_MALWARE_S3_REGION', 'AIE_MALWARE_SCAN_ADMISSION_WINDOW_MINUTES', 'FDH_DOCUMENT_UPLOAD_ENABLED',
  'AIE_ALLOW_AI_FALLBACK_WITHOUT_REAL_SCAN', 'AIE_ALLOW_MISSING_SIGNATURE_SCANNER', 'AIE_DOCUMENT_INTAKE_ENABLED', 'AIE_FDH_BANK_ADAPTER_ENABLED',
  'AIE_II_ADAPTER_ENABLED', 'AIE_INSURANCE_ADAPTER_ENABLED', 'AIE_II_ADAPTER_CANONICAL_WRITE_ENABLED', 'AIE_INSURANCE_ADAPTER_CANONICAL_WRITE_ENABLED',
  'AIE_FDH_BANK_ATOMIC_IMPORT_ENABLED', 'AIE_FDH_BANK_AI_FALLBACK_ENABLED', 'AIE_REVIEW_UI_ENABLED', 'AIE_REVIEW_BULK_ACTIONS_ENABLED',
  'AIE_REVIEW_CANONICAL_ACCEPTANCE_ENABLED', 'AIE_REVIEW_EVIDENCE_REVEAL_ENABLED', 'AIE_REVIEW_PC5_PROJECTION_ENABLED', 'FACTSHEET_READER_AI_ENABLED',
  'AIE_PILOT_COHORT_ENFORCED', 'II_AI_FALLBACK_PILOT_COHORT_ENFORCED', 'MODULE11_AI_PROVIDER', 'MODULE11_AI_MODEL'
)

# name, expectation kind, expected value
#   true   = must be exactly "true"          present = must exist (value hidden)        equals = must equal the value
#   unset  = must be missing or "false"      info    = report only
$Rules = @(
  @('AIE_AI_FALLBACK_ENABLED', 'true', ''), @('II_AI_FALLBACK_ENABLED', 'true', ''),
  @('AIE_PAYSLIP_AI_FALLBACK_ENABLED', 'true', ''), @('AIE_BANK_STATEMENT_AI_FALLBACK_ENABLED', 'true', ''),
  @('AIE_INVESTMENT_STATEMENT_AI_FALLBACK_ENABLED', 'true', ''), @('AIE_LIABILITY_AI_FALLBACK_ENABLED', 'true', ''),
  @('AIE_RETIREMENT_STATEMENT_AI_FALLBACK_ENABLED', 'true', ''), @('AIE_REAL_MALWARE_SCAN_ENABLED', 'true', ''),
  @('AIE_AI_PROVIDER', 'equals', 'openai'),
  @('AIE_OPENAI_API_KEY', 'present', ''), @('AIE_MASK_TOKEN_ENCRYPTION_KEY', 'present', ''),
  @('AIE_MALWARE_S3_BUCKET', 'present', ''), @('AIE_MALWARE_S3_REGION', 'present', ''), @('AIE_MALWARE_S3_ACCOUNT_ID', 'present', ''),
  @('AIE_MALWARE_AWS_ACCESS_KEY_ID', 'present', ''), @('AIE_MALWARE_AWS_SECRET_ACCESS_KEY', 'present', ''),
  @('SUPABASE_SERVICE_ROLE_KEY', 'present', ''), @('CRON_SECRET', 'present', ''), @('APP_BASE_URL', 'present', ''),
  @('AIE_AI_MODEL', 'info', 'unset or gpt-4o-mini; any other model is refused by the gateway'),
  @('AIE_AI_COST_ALLOWANCE_USD', 'info', 'can only LOWER the stored global ceiling (never raise it)'),
  @('AIE_USER_DAILY_COST_CAP_USD', 'info', 'can only LOWER the stored per-user cap; leave unset'),
  @('FDH_DOCUMENT_UPLOAD_ENABLED', 'info', 'NOT forwarded by amplify.yml: a console value never reaches the server (open finding)'),
  @('AIE_ALLOW_AI_FALLBACK_WITHOUT_REAL_SCAN', 'unset', ''), @('AIE_ALLOW_MISSING_SIGNATURE_SCANNER', 'unset', ''),
  @('AIE_DOCUMENT_INTAKE_ENABLED', 'unset', ''), @('AIE_FDH_BANK_ADAPTER_ENABLED', 'unset', ''), @('AIE_II_ADAPTER_ENABLED', 'unset', ''),
  @('AIE_INSURANCE_ADAPTER_ENABLED', 'unset', ''), @('AIE_II_ADAPTER_CANONICAL_WRITE_ENABLED', 'unset', ''),
  @('AIE_INSURANCE_ADAPTER_CANONICAL_WRITE_ENABLED', 'unset', ''), @('AIE_FDH_BANK_ATOMIC_IMPORT_ENABLED', 'unset', ''),
  @('AIE_FDH_BANK_AI_FALLBACK_ENABLED', 'unset', ''), @('AIE_REVIEW_UI_ENABLED', 'unset', ''), @('AIE_REVIEW_BULK_ACTIONS_ENABLED', 'unset', ''),
  @('AIE_REVIEW_CANONICAL_ACCEPTANCE_ENABLED', 'unset', ''), @('AIE_REVIEW_EVIDENCE_REVEAL_ENABLED', 'unset', ''), @('AIE_REVIEW_PC5_PROJECTION_ENABLED', 'unset', ''),
  @('FACTSHEET_READER_AI_ENABLED', 'unset', ''),
  @('AIE_PILOT_COHORT_ENFORCED', 'info', 'retired: no code reads it. Delete after a stable day'),
  @('AIE_PILOT_COHORT_EMAILS', 'info', 'retired'), @('AIE_PILOT_COHORT_USER_IDS', 'info', 'retired'),
  @('II_AI_FALLBACK_PILOT_COHORT_ENFORCED', 'info', 'retired'), @('II_AI_FALLBACK_PILOT_COHORT_EMAILS', 'info', 'retired'), @('II_AI_FALLBACK_PILOT_COHORT_USER_IDS', 'info', 'retired'),
  @('MODULE11_AI_PROVIDER', 'info', 'Module 11 only. Not forwarded by amplify.yml on main'), @('MODULE11_AI_MODEL', 'info', 'Module 11 only'),
  @('OPENAI_API_KEY', 'info', 'Module 11 only. Not forwarded by amplify.yml on main')
)

function Get-EnvMap([string]$json) {
  $map = @{}
  if ([string]::IsNullOrWhiteSpace($json) -or $json.Trim() -eq 'null') { return $map }
  $obj = $json | ConvertFrom-Json
  if ($null -ne $obj) { foreach ($p in $obj.PSObject.Properties) { $map[$p.Name] = [string]$p.Value } }
  return $map
}

$regionArgs = @()
if ($Region) { $regionArgs = @('--region', $Region) }

Write-Host "Reading Amplify variables for app $AppId, branch $Branch (names and plain switches only; secrets are never printed)."
$appJson = (aws amplify get-app --app-id $AppId @regionArgs --query 'app.environmentVariables' --output json) -join "`n"
$brJson = (aws amplify get-branch --app-id $AppId --branch-name $Branch @regionArgs --query 'branch.environmentVariables' --output json) -join "`n"
$appVars = Get-EnvMap $appJson
$brVars = Get-EnvMap $brJson
Write-Host ("App-level variables: {0}. Branch-level variables: {1}." -f $appVars.Count, $brVars.Count)

$rows = foreach ($r in $Rules) {
  $name = $r[0]; $kind = $r[1]; $want = $r[2]
  $source = 'none'; $value = $null
  if ($brVars.ContainsKey($name)) { $source = 'branch'; $value = $brVars[$name] }
  elseif ($appVars.ContainsKey($name)) { $source = 'app'; $value = $appVars[$name] }
  $present = ($source -ne 'none')
  $shown = if (-not $present) { '-' } elseif ($ShowValue -contains $name) { $value } else { 'set (hidden)' }
  $fwd = $false
  foreach ($t in $ForwardedTerms) { if ($name.Contains($t)) { $fwd = $true } }
  $verdict = switch ($kind) {
    'true'    { if ($present -and $value -eq 'true') { 'OK' } elseif ($present) { 'CHECK: not exactly true' } else { 'MISSING' } }
    'equals'  { if ($present -and $value -eq $want) { 'OK' } elseif ($present) { 'CHECK: wrong value' } else { 'MISSING' } }
    'present' { if ($present -and $value.Length -gt 0) { 'OK' } else { 'MISSING' } }
    'unset'   { if (-not $present -or $value -eq 'false') { 'OK' } else { 'CHECK: should be unset or false' } }
    default   { if ($present) { 'info: set' } else { 'info: not set' } }
  }
  if ($present -and -not $fwd -and $kind -ne 'info' -and $kind -ne 'unset') { $verdict = "$verdict; NOT FORWARDED by amplify.yml, the server never sees it" }
  [pscustomobject]@{ Name = $name; Source = $source; Value = $shown; Forwarded = $fwd; Expect = if ($want) { "$kind $want" } else { $kind }; Verdict = $verdict }
}
$rows | Format-Table -AutoSize -Wrap | Out-String -Width 220 | Write-Host

$unknown = @($appVars.Keys + $brVars.Keys | Where-Object { $_ -match '^(AIE_|II_AI_FALLBACK_|MODULE11_|FACTSHEET_)' } | Sort-Object -Unique | Where-Object { $n = $_; -not ($Rules | Where-Object { $_[0] -eq $n }) })
if ($unknown.Count -gt 0) { Write-Host ("Other AI-related names present (values hidden): " + ($unknown -join ', ')) }
Write-Host 'Done. Nothing was changed. Paste the table (it contains no secrets) into the evidence sheet.'
