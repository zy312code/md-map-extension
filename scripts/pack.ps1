# Builds md-map-<version>.vsix without Node/vsce. Zip entries must use forward slashes,
# which Compress-Archive on Windows PowerShell 5.1 does not guarantee.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$pkg = [IO.File]::ReadAllText((Join-Path $root 'package.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
$include = @('package.json', 'extension.js', 'core', 'media', 'translate')
$files = foreach ($item in $include) {
    $path = Join-Path $root $item
    if (Test-Path $path -PathType Container) { Get-ChildItem $path -Recurse -File } else { Get-Item $path }
}

function Esc([string]$s) { [Security.SecurityElement]::Escape($s) }
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="$(Esc $pkg.name)" Version="$(Esc $pkg.version)" Publisher="$(Esc $pkg.publisher)" />
    <DisplayName>$(Esc $pkg.displayName)</DisplayName>
    <Description xml:space="preserve">$(Esc $pkg.description)</Description>
    <Tags></Tags>
    <Categories>$(Esc ($pkg.categories -join ','))</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$(Esc $pkg.engines.vscode)" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
"@

$mime = @{ '.json' = 'application/json'; '.js' = 'application/javascript'; '.css' = 'text/css'; '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.md' = 'text/markdown'; '.vsixmanifest' = 'text/xml' }
$exts = @($files | ForEach-Object { $_.Extension.ToLower() }) + '.vsixmanifest' | Sort-Object -Unique
$types = ($exts | ForEach-Object {
        $type = $mime[$_]; if (-not $type) { $type = 'application/octet-stream' }
        "<Default Extension=`"$_`" ContentType=`"$type`" />"
    }) -join ''
$contentTypes = "<?xml version=`"1.0`" encoding=`"utf-8`"?><Types xmlns=`"http://schemas.openxmlformats.org/package/2006/content-types`">$types</Types>"

$out = Join-Path $root "$($pkg.name)-$($pkg.version).vsix"
if (Test-Path $out) { Remove-Item $out }
$utf8 = New-Object Text.UTF8Encoding $false
$zip = [IO.Compression.ZipFile]::Open($out, 'Create')
try {
    foreach ($entry in @(@('extension.vsixmanifest', $manifest), @('[Content_Types].xml', $contentTypes))) {
        $writer = New-Object IO.StreamWriter ($zip.CreateEntry($entry[0]).Open()), $utf8
        $writer.Write($entry[1]); $writer.Dispose()
    }
    foreach ($f in $files) {
        $name = 'extension/' + $f.FullName.Substring($root.Length + 1).Replace('\', '/')
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.FullName, $name)
    }
} finally { $zip.Dispose() }
Write-Host "packed $($files.Count) files -> $out"
