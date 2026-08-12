$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$env:CARGO_HOME = "D:\DevTools\JuvenileScholar\cargo"
$env:RUSTUP_HOME = "D:\DevTools\JuvenileScholar\rustup"
$env:CARGO_TARGET_DIR = Join-Path $projectRoot "target"
$env:TEMP = Join-Path $projectRoot ".tmp"
$env:TMP = $env:TEMP
$env:PATH = "$env:CARGO_HOME\bin;C:\Users\86178\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;$env:PATH"

Set-Location $projectRoot
& (Join-Path $projectRoot "node_modules\.bin\tauri.cmd") build --bundles nsis
exit $LASTEXITCODE

