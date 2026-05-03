$secureApiKey = Read-Host "Paste your OpenAI API key" -AsSecureString
$apiKeyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureApiKey)

try {
  $plainApiKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($apiKeyPointer)
}
finally {
  if ($apiKeyPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($apiKeyPointer)
  }
}

if ([string]::IsNullOrWhiteSpace($plainApiKey)) {
  Write-Error "No API key was entered."
  exit 1
}

$env:OPENAI_API_KEY = $plainApiKey

Write-Host "OPENAI_API_KEY is set for this terminal session." -ForegroundColor Green
Write-Host "Next run: .\scripts\generate-site-images.ps1" -ForegroundColor Yellow