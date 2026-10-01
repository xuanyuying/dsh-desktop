# Render the app icon from the official DeepSeek whale.
#
# Input : build/whale-source.png  (official favicon; dark whale, alpha channel)
# Output: build/icon.png          (256x256, white whale on a vivid blue tile)
#
# Design: rounded-square tile in vivid blue (#2B5CFF) with the whale knocked out
# in white. A solid tile reads far better than a bare glyph at 16px in the
# taskbar, and stays legible on both light and dark backgrounds.
#
# The whale is recoloured with a ColorMatrix that forces RGB to a constant while
# keeping the source alpha, so the anti-aliased edges survive intact.
#
# ASCII-only on purpose: powershell.exe reads a BOM-less .ps1 as ANSI.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$srcPath = Join-Path $root 'build\whale-source.png'
$outPath = Join-Path $root 'build\icon.png'

# --- look ---
$bgR = 43;  $bgG = 92;  $bgB = 255     # #2B5CFF  vivid blue tile
$inkR = 255; $inkG = 255; $inkB = 255  # white whale
$size = 256
$radius = 56      # tile corner radius (~22%, the Windows app-icon look)
$fill = 0.60      # how much of the canvas the whale occupies

if (-not (Test-Path $srcPath)) {
  Write-Error "missing source image: $srcPath"
  exit 1
}

$src = [System.Drawing.Bitmap]::FromFile($srcPath)

# --- bounding box of the non-transparent pixels ---
$minX = $src.Width; $minY = $src.Height; $maxX = -1; $maxY = -1
for ($y = 0; $y -lt $src.Height; $y++) {
  for ($x = 0; $x -lt $src.Width; $x++) {
    if ($src.GetPixel($x, $y).A -gt 8) {
      if ($x -lt $minX) { $minX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}

if ($maxX -lt 0) {
  Write-Error 'source image has no visible pixels'
  $src.Dispose()
  exit 1
}

$inkW = $maxX - $minX + 1
$inkH = $maxY - $minY + 1

# --- remap RGB to the ink colour, keep alpha ---
#
# GDI+ applies the matrix as  [R G B A 1] x M , so the CONSTANT colour lives in
# the fifth ROW (Matrix40..Matrix42). Putting it in the fifth column only
# multiplies the source channels (all ~0 for a black whale) and yields black.
$cm = New-Object System.Drawing.Imaging.ColorMatrix
$cm.Matrix00 = 0; $cm.Matrix01 = 0; $cm.Matrix02 = 0; $cm.Matrix03 = 0; $cm.Matrix04 = 0
$cm.Matrix10 = 0; $cm.Matrix11 = 0; $cm.Matrix12 = 0; $cm.Matrix13 = 0; $cm.Matrix14 = 0
$cm.Matrix20 = 0; $cm.Matrix21 = 0; $cm.Matrix22 = 0; $cm.Matrix23 = 0; $cm.Matrix24 = 0
$cm.Matrix30 = 0; $cm.Matrix31 = 0; $cm.Matrix32 = 0; $cm.Matrix33 = 1; $cm.Matrix34 = 0
$cm.Matrix40 = ($inkR / 255.0)
$cm.Matrix41 = ($inkG / 255.0)
$cm.Matrix42 = ($inkB / 255.0)
$cm.Matrix43 = 0
$cm.Matrix44 = 1

$ia = New-Object System.Drawing.Imaging.ImageAttributes
$ia.SetColorMatrix($cm)

$dst = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($dst)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
$g.Clear([System.Drawing.Color]::Transparent)

# --- rounded-square tile ---
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = $radius * 2
$path.AddArc(0, 0, $d, $d, 180, 90)
$path.AddArc($size - $d, 0, $d, $d, 270, 90)
$path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
$path.AddArc(0, $size - $d, $d, $d, 90, 90)
$path.CloseFigure()
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, $bgR, $bgG, $bgB))
$g.FillPath($brush, $path)
$brush.Dispose()
$path.Dispose()

# --- whale, centred ---
$box = [int]($size * $fill)
$scale = [Math]::Min($box / $inkW, $box / $inkH)
$drawW = [int][Math]::Round($inkW * $scale)
$drawH = [int][Math]::Round($inkH * $scale)
$offX = [int](($size - $drawW) / 2)
$offY = [int](($size - $drawH) / 2)

$dstRect = New-Object System.Drawing.Rectangle $offX, $offY, $drawW, $drawH
$g.DrawImage($src, $dstRect, $minX, $minY, $inkW, $inkH, [System.Drawing.GraphicsUnit]::Pixel, $ia)

$g.Dispose()
$ia.Dispose()
$dst.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$dst.Dispose()
$src.Dispose()

Write-Host ("icon.png written: {0}x{1}, tile #2B5CFF, white whale, ink {2}x{3}" -f $size, $size, $inkW, $inkH)
