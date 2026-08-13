$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$env:CARGO_TARGET_DIR = Join-Path $projectRoot "target"
$env:TEMP = Join-Path $projectRoot ".tmp"
$env:TMP = $env:TEMP

Set-Location $projectRoot
pnpm build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
pnpm tauri build --bundles nsis
exit $LASTEXITCODE
