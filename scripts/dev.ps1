$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$env:CARGO_TARGET_DIR = Join-Path $projectRoot "target"
$env:TEMP = Join-Path $projectRoot ".tmp"
$env:TMP = $env:TEMP

Set-Location $projectRoot
$frontend = Start-Process -FilePath "pnpm" -ArgumentList "dev" -WorkingDirectory $projectRoot -PassThru -WindowStyle Hidden
try {
  pnpm tauri dev
} finally {
  Stop-Process -Id $frontend.Id -ErrorAction SilentlyContinue
}
exit $LASTEXITCODE
