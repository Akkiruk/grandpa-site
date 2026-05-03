param(
  [int]$Port = 8000
)

$ErrorActionPreference = 'Stop'

$root = [System.IO.Path]::GetFullPath($PSScriptRoot)

$contentTypes = @{
  '.html' = 'text/html; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'
  '.js' = 'application/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg' = 'image/svg+xml'
  '.png' = 'image/png'
  '.jpg' = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.gif' = 'image/gif'
  '.webp' = 'image/webp'
  '.ico' = 'image/x-icon'
  '.txt' = 'text/plain; charset=utf-8'
}

$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()

Write-Host "Serving $root at http://localhost:$Port/"

try {
  while ($listener.IsListening) {
    $context = $listener.GetContext()
    $request = $context.Request
    $response = $context.Response

    try {
      $relativePath = [System.Uri]::UnescapeDataString($request.Url.AbsolutePath.TrimStart('/'))

      if ([string]::IsNullOrWhiteSpace($relativePath)) {
        $relativePath = 'index.html'
      }

      $candidatePath = [System.IO.Path]::GetFullPath((Join-Path $root $relativePath))

      if (-not $candidatePath.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw [System.UnauthorizedAccessException]::new('Invalid path.')
      }

      if ((Test-Path $candidatePath) -and (Get-Item $candidatePath).PSIsContainer) {
        $candidatePath = Join-Path $candidatePath 'index.html'
      }

      if (-not (Test-Path $candidatePath)) {
        $response.StatusCode = 404
        $body = [System.Text.Encoding]::UTF8.GetBytes('Not found')
        $response.ContentType = 'text/plain; charset=utf-8'
        $response.OutputStream.Write($body, 0, $body.Length)
        continue
      }

      $extension = [System.IO.Path]::GetExtension($candidatePath).ToLowerInvariant()
      $response.ContentType = $contentTypes[$extension]

      if (-not $response.ContentType) {
        $response.ContentType = 'application/octet-stream'
      }

      $bytes = [System.IO.File]::ReadAllBytes($candidatePath)
      $response.ContentLength64 = $bytes.Length
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
      Write-Host ("[{0}] {1}" -f $response.StatusCode, $request.RawUrl)
    }
    catch [System.UnauthorizedAccessException] {
      $response.StatusCode = 403
      $body = [System.Text.Encoding]::UTF8.GetBytes('Forbidden')
      $response.ContentType = 'text/plain; charset=utf-8'
      $response.OutputStream.Write($body, 0, $body.Length)
    }
    catch {
      $response.StatusCode = 500
      $body = [System.Text.Encoding]::UTF8.GetBytes('Server error')
      $response.ContentType = 'text/plain; charset=utf-8'
      $response.OutputStream.Write($body, 0, $body.Length)
      Write-Error $_
    }
    finally {
      $response.OutputStream.Close()
    }
  }
}
finally {
  $listener.Stop()
  $listener.Close()
}