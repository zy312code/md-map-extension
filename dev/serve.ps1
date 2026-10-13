# Dev only: writes dev/files.json and serves the repo root at http://localhost:<Port>/ for dev/harness.html.
param([int]$Port = 8765)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$exclude = '[\\/](node_modules|\.git|\.venv|venv|dist|__pycache__)[\\/]'
$files = @(Get-ChildItem $root -Recurse -File -Force -Include *.md, *.markdown |
    Where-Object { $_.FullName -notmatch $exclude } |
    ForEach-Object {
        [pscustomobject]@{
            path  = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
            size  = $_.Length
            mtime = [long]($_.LastWriteTimeUtc - [datetime]'1970-01-01').TotalMilliseconds
        }
    })
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'files.json'), (ConvertTo-Json -InputObject $files -Compress), (New-Object Text.UTF8Encoding $false))
Write-Host "files.json: $($files.Count) files"
$codeExt = '\.(py|ts|tsx|js|jsx|mjs|go|rs|java|kt|cs|rb|php|swift|c|cc|cpp|h|hpp|scala|dart|vue|svelte)$'
$code = @(Get-ChildItem $root -Recurse -File -Force |
    Where-Object { $_.Name -match $codeExt -and $_.FullName -notmatch $exclude } |
    ForEach-Object { $_.FullName.Substring($root.Length + 1).Replace('\', '/') })
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'code.json'), (ConvertTo-Json -InputObject $code -Compress), (New-Object Text.UTF8Encoding $false))
Write-Host "code.json: $($code.Count) files"

$types = @{ '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8';
    '.json' = 'application/json; charset=utf-8'; '.md' = 'text/plain; charset=utf-8'; '.svg' = 'image/svg+xml'; '.png' = 'image/png' }
$listener = New-Object Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "serving $root on http://localhost:$Port/"
while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $path = Join-Path $root ([Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/')))
    if (Test-Path $path -PathType Leaf) {
        $bytes = [IO.File]::ReadAllBytes($path)
        $type = $types[[IO.Path]::GetExtension($path).ToLower()]
        if ($type) { $ctx.Response.ContentType = $type }
        $ctx.Response.Headers.Add('Cache-Control', 'no-store')
        $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
        $ctx.Response.StatusCode = 404
    }
    $ctx.Response.Close()
}
