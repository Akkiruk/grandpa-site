param(
  [string]$ProjectName = "memories-2-dvd-usb",
  [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"

$secureKey = Read-Host "Paste your OpenRouter API key" -AsSecureString
$keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)

try {
  $plainKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
  if ([string]::IsNullOrWhiteSpace($plainKey)) {
    throw "An OpenRouter API key is required."
  }

  $plainKey | npx wrangler pages secret put OPENROUTER_API_KEY --project-name $ProjectName
  if ($LASTEXITCODE -ne 0) {
    throw "Cloudflare could not save the OpenRouter key."
  }
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
  $plainKey = $null
  $secureKey.Dispose()
}

npm run build
if ($LASTEXITCODE -ne 0) {
  throw "The site build failed."
}

npx wrangler pages deploy dist --project-name $ProjectName --branch $Branch
if ($LASTEXITCODE -ne 0) {
  throw "The site deployment failed."
}

Write-Host "OpenRouter is configured and deployed." -ForegroundColor Green
