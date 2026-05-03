param(
  [string]$PromptsFile = ".\scripts\site-image-prompts.json",
  [string]$OutputDir = ".\assets\generated",
  [switch]$ListPrompts
)

function Import-DotEnv {
  param(
    [string]$EnvFile = ".\.env"
  )

  if (-not (Test-Path -LiteralPath $EnvFile)) {
    return
  }

  foreach ($line in Get-Content -LiteralPath $EnvFile) {
    $trimmedLine = $line.Trim()

    if ([string]::IsNullOrWhiteSpace($trimmedLine) -or $trimmedLine.StartsWith('#')) {
      continue
    }

    $parts = $trimmedLine -split '=', 2

    if ($parts.Count -ne 2) {
      continue
    }

    $key = $parts[0].Trim()
    $value = $parts[1].Trim()

    if ($value.StartsWith('"') -and $value.EndsWith('"')) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    if (-not [string]::IsNullOrWhiteSpace($key) -and [string]::IsNullOrWhiteSpace((Get-Item -Path "Env:$key" -ErrorAction SilentlyContinue).Value)) {
      Set-Item -Path "Env:$key" -Value $value
    }
  }
}

function Get-ImageRequestBody {
  param(
    [pscustomobject]$PromptSpec
  )

  $body = [ordered]@{
    model = $(if ($PromptSpec.model) { $PromptSpec.model } else { "gpt-image-1" })
    prompt = $PromptSpec.prompt
    size = $(if ($PromptSpec.size) { $PromptSpec.size } else { "1536x1024" })
  }

  if ($PromptSpec.quality) {
    $body.quality = $PromptSpec.quality
  }

  return $body
}

if (-not (Test-Path -LiteralPath $PromptsFile)) {
  Write-Error "Prompts file not found: $PromptsFile"
  exit 1
}

$promptSpecs = Get-Content -LiteralPath $PromptsFile -Raw | ConvertFrom-Json

if ($ListPrompts) {
  $promptSpecs |
    Select-Object id, filename, usage |
    Format-Table -AutoSize |
    Out-String |
    Write-Host
  exit 0
}

Import-DotEnv

if ([string]::IsNullOrWhiteSpace($env:OPENAI_API_KEY)) {
  Write-Error "OPENAI_API_KEY is not set. Add it to .env or set it in this terminal session."
  exit 1
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$headers = @{
  Authorization = "Bearer $($env:OPENAI_API_KEY)"
  "Content-Type" = "application/json"
}

foreach ($promptSpec in $promptSpecs) {
  $outputPath = Join-Path $OutputDir $promptSpec.filename
  $requestBody = Get-ImageRequestBody -PromptSpec $promptSpec | ConvertTo-Json -Depth 5 -Compress

  Write-Host "Generating $($promptSpec.id)..." -ForegroundColor Cyan

  try {
    $response = Invoke-RestMethod -Uri "https://api.openai.com/v1/images/generations" -Method Post -Headers $headers -Body $requestBody
  }
  catch {
    $apiMessage = if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
      $_.ErrorDetails.Message
    }
    else {
      $_.Exception.Message
    }

    Write-Error "Failed while generating $($promptSpec.id): $apiMessage"
    exit 1
  }

  if ($response.data[0].b64_json) {
    [IO.File]::WriteAllBytes($outputPath, [Convert]::FromBase64String($response.data[0].b64_json))
    Write-Host "Saved $outputPath" -ForegroundColor Green
    continue
  }

  if ($response.data[0].url) {
    Invoke-WebRequest -Uri $response.data[0].url -OutFile $outputPath
    Write-Host "Saved $outputPath" -ForegroundColor Green
    continue
  }

  Write-Error "The API response for $($promptSpec.id) did not include image data."
  exit 1
}

Write-Host "Finished generating site images." -ForegroundColor Green