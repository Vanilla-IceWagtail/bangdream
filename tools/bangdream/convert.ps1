# Convert doll images to real PNG (ASCII only on purpose: Windows PowerShell 5.1
# reads BOM-less UTF-8 .ps1 as ANSI/GBK and would corrupt non-ASCII source).
#
# Why: 40 of the 45 files in the source folder are actually JPEG (no alpha) even
# though they are named .PNG. The game needs a real alpha silhouette, so convert
# everything to PNG and downscale the long edge (originals are ~2300x2900).
#
# Usage:
#   powershell -File tools/bangdream/convert.ps1 -Src <dir> -Out <dir> [-MaxEdge 1024]

param(
  [Parameter(Mandatory = $true)][string]$Src,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$MaxEdge = 1024
)

Add-Type -AssemblyName System.Drawing

function Get-ImageKind([string]$path) {
  $fs = [System.IO.File]::OpenRead($path)
  try {
    $buf = New-Object byte[] 12
    $null = $fs.Read($buf, 0, 12)
  } finally { $fs.Dispose() }
  if ($buf[0] -eq 0x89 -and $buf[1] -eq 0x50 -and $buf[2] -eq 0x4E -and $buf[3] -eq 0x47) { return 'png' }
  if ($buf[0] -eq 0xFF -and $buf[1] -eq 0xD8) { return 'jpeg' }
  if ($buf[0] -eq 0x52 -and $buf[1] -eq 0x49 -and $buf[2] -eq 0x46 -and $buf[3] -eq 0x46) { return 'webp' }
  return 'other'
}

$rootPath = (Resolve-Path $Src).Path
$files = Get-ChildItem -Path $Src -Recurse -File | Where-Object { $_.Extension -match '^\.(png|jpg|jpeg|webp)$' }
Write-Host ("found {0} image files" -f $files.Count)

$converted = 0
$kept = 0
$failed = 0

foreach ($f in $files) {
  $rel = $f.FullName.Substring($rootPath.Length).TrimStart('\', '/')
  $target = Join-Path $Out ([System.IO.Path]::ChangeExtension($rel, '.png'))
  $targetDir = Split-Path $target -Parent
  if (-not (Test-Path $targetDir)) { New-Item -ItemType Directory -Force -Path $targetDir | Out-Null }

  $kind = Get-ImageKind $f.FullName
  try {
    $img = [System.Drawing.Image]::FromFile($f.FullName)
    try {
      $ratio = [Math]::Min(1.0, $MaxEdge / [Math]::Max($img.Width, $img.Height))
      $w = [int][Math]::Round($img.Width * $ratio)
      $h = [int][Math]::Round($img.Height * $ratio)
      $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      try {
        $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.Clear([System.Drawing.Color]::Transparent)
        $g.DrawImage($img, 0, 0, $w, $h)
      } finally { $g.Dispose() }
      $bmp.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()
      if ($kind -eq 'png') { $kept++ } else { $converted++ }
      Write-Host ("  [{0}] {1} {2}x{3} -> {4}x{5}" -f $kind, $rel, $img.Width, $img.Height, $w, $h)
    } finally { $img.Dispose() }
  } catch {
    $failed++
    Write-Warning ("  FAILED {0} : {1}" -f $rel, $_.Exception.Message)
  }
}

Write-Host ""
Write-Host ("done: converted {0}, re-saved png {1}, failed {2}" -f $converted, $kept, $failed)
Write-Host ("out: {0}" -f $Out)
