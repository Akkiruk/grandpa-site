param(
  [string]$OutputDir = ".\dist"
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$resolvedOutputDir = if ([IO.Path]::IsPathRooted($OutputDir)) {
  $OutputDir
} else {
  Join-Path $root $OutputDir
}

if (Test-Path -LiteralPath $resolvedOutputDir) {
  Remove-Item -LiteralPath $resolvedOutputDir -Recurse -Force
}

New-Item -ItemType Directory -Path $resolvedOutputDir | Out-Null

$rootFiles = @(
  "index.html",
  "about.html",
  "services.html",
  "process.html",
  "pricing.html",
  "styles.css",
  "script.js"
)

foreach ($file in $rootFiles) {
  Copy-Item -LiteralPath (Join-Path $root $file) -Destination (Join-Path $resolvedOutputDir $file)
}

Copy-Item -LiteralPath (Join-Path $root "assets") -Destination (Join-Path $resolvedOutputDir "assets") -Recurse

Write-Host "Staged Cloudflare Pages assets to $resolvedOutputDir" -ForegroundColor Green