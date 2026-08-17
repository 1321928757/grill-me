param(
  [string]$Task = "用户想做一个'智能体系统'。先用 grill-me 拷打边界，再输出明确需求"
)

$ErrorActionPreference = 'Stop'

if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
  throw 'dsh CLI is not installed; install DeepSeek Harness first'
}
if (-not $env:DEEPSEEK_API_KEY) {
  throw 'DEEPSEEK_API_KEY is not set'
}

$root = Split-Path -Parent $PSScriptRoot
$work = Join-Path ([System.IO.Path]::GetTempPath()) 'grill-me-e2e'
Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $work | Out-Null

Push-Location $work
try {
  dsh plugin --profile headless add $root
  if ($LASTEXITCODE -ne 0) { throw 'plugin add failed' }
  dsh --profile headless --dump-config | Select-String 'id: grill-me'
  if ($LASTEXITCODE -ne 0) { throw 'composition check failed' }
  dsh --profile headless $Task
  if ($LASTEXITCODE -ne 0) { throw 'headless task failed' }
  $sessions = Get-ChildItem (Join-Path $work '.grill-me') -Directory -ErrorAction SilentlyContinue
  if (-not $sessions) { throw 'no .grill-me session files produced' }
  $sessions | Select-Object -ExpandProperty FullName
  Write-Output 'E2E passed: session state persisted.'
} finally {
  Pop-Location
}