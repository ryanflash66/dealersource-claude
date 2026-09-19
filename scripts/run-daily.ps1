# dealersource daily run for Windows Task Scheduler.
# Pulls the latest main, installs deps if the lockfile changed, loads .env, runs the pipeline online,
# and appends a dated log under out/logs/. Never prints secret values.
# Native commands (git, npm) write progress to stderr; do not let PowerShell treat that as an error.
$ErrorActionPreference = "Continue"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$date = Get-Date -Format "yyyy-MM-dd"
New-Item -ItemType Directory -Force -Path (Join-Path $repo "out\logs") | Out-Null
$log = Join-Path $repo "out\logs\$date.log"
function Log($msg) { $line = "[{0}] {1}" -f (Get-Date -Format "s"), $msg; Add-Content -Path $log -Value $line; Write-Host $line }

try {
  Log "start; repo=$repo"
  $before = git rev-parse HEAD
  git pull --ff-only origin main 2>&1 | ForEach-Object { Log "git: $_" }
  if ($LASTEXITCODE -ne 0) { throw "git pull failed with exit $LASTEXITCODE" }
  $after = git rev-parse HEAD
  if ($before -ne $after -or -not (Test-Path (Join-Path $repo "node_modules"))) {
    Log "installing dependencies (commit changed or node_modules missing)"
    npm ci --silent 2>&1 | ForEach-Object { Log "npm: $_" }
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit $LASTEXITCODE" }
  }
  $envFile = Join-Path $repo ".env"
  if (-not (Test-Path $envFile)) { throw ".env not found at $envFile" }
  $loaded = @()
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Z_]+)=(.*)$' -and $matches[2].Trim() -ne "") {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim(), "Process")
      $loaded += $matches[1]
    }
  }
  Log ("env loaded: " + ($loaded -join ", "))
  $out = "out/$date"
  # Call tsx directly: npm.cmd invoked from PowerShell drops every argument after "--".
  $tsx = Join-Path $repo "node_modules.bin	sx.cmd"
  Log "tsx src/cli.ts run --out $out --run-date $date"
  & $tsx src/cli.ts run --out $out --run-date $date 2>&1 | ForEach-Object { Add-Content -Path $log -Value $_ }
  $code = $LASTEXITCODE
  $run = Join-Path $repo "$out\run.json"
  if (Test-Path $run) {
    $r = Get-Content $run -Raw | ConvertFrom-Json
    Log ("done exit=$code status=" + $r.status + " sites=" + $r.counts.'report.sites_reported' + " messages_sent=" + $r.counts.messages_sent + " errors=" + $r.errors.Count + " paused=" + $r.sending_paused)
  } else {
    Log "done exit=$code (no run.json written)"
  }
  exit $code
} catch {
  Log ("FAILED: " + $_.Exception.Message)
  exit 1
}
