param(
  [string]$Repo = 'grill-me',
  [switch]$Public,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  if ($SkipInstall) { throw 'gh is not installed' }
  winget install --id GitHub.cli --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) { throw 'gh install failed' }
}

gh auth status | Out-Null

$visibility = if ($Public) { '--public' } else { '--private' }
gh repo create "NanmiCoder/$Repo" $visibility --add-readme 2>$null
if ($LASTEXITCODE -ne 0) { throw 'gh repo create failed' }

git remote remove origin 2>$null
git remote add origin "https://github.com/NanmiCoder/$Repo.git"
git fetch origin
git branch -f main origin/main
git checkout -B main origin/main
git push -u origin main
git switch codex/scaffold-grill-me
git push -u origin codex/scaffold-grill-me

gh pr create --base main --head codex/scaffold-grill-me --title "feat: scaffold grill-me DSH plugin with human-review pipeline" --body-file "$root/.github/PULL_REQUEST_TEMPLATE.md"
Write-Output "PR created: https://github.com/NanmiCoder/$Repo/pull/new/codex%2Fscaffold-grill-me"