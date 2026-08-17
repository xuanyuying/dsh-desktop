/**
 * 生成标准 BMP 格式的 Windows .ico（多尺寸）
 * electron-builder 可直接使用，无需调用图标转换工具（避免 spawn EPERM）
 * 用法: node scripts/gen-ico.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// 用 PowerShell System.Drawing 生成 BMP 格式 ICO（最可靠，避免手写字节）
const psScript = `
Add-Type -AssemblyName System.Drawing
function New-Icon([string]$pngPath, [string]$icoPath) {
  $png = [System.Drawing.Image]::FromFile($pngPath)
  $sizes = @(16, 24, 32, 48, 64, 128, 256)
  $images = @()
  foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $s, $s, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($png, 0, 0, $s, $s)
    $g.Dispose()
    $images += ,$bmp
  }
  # ICONDIR
  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $bw.Write([UInt16]0)         # reserved
  $bw.Write([UInt16]1)         # type = icon
  $bw.Write([UInt16]$images.Count)
  $offset = 6 + 16 * $images.Count
  $data = @()
  foreach ($bmp in $images) {
    $s = $bmp.Width
    # BITMAPINFOHEADER (40 bytes) + BGRA pixels (bottom-up) + AND mask
    $w = $s; $h = $s
    $ih = New-Object System.IO.MemoryStream
    $iw = New-Object System.IO.BinaryWriter($ih)
    $iw.Write([UInt32]40)                 # biSize
    $iw.Write([Int32]$w)                  # biWidth
    $iw.Write([Int32]($h * 2))            # biHeight (XOR + AND)
    $iw.Write([UInt16]1)                  # biPlanes
    $iw.Write([UInt16]32)                 # biBitCount
    $iw.Write([UInt32]0)                  # biCompression = BI_RGB
    $iw.Write([UInt32]0)                  # biSizeImage
    $iw.Write([Int32]0); $iw.Write([Int32]0)  # biXPelsPerMeter, biYPelsPerMeter
    $iw.Write([UInt32]0); $iw.Write([UInt32]0)  # biClrUsed, biClrImportant
    # 像素：bottom-up BGRA
    for ($y = $h - 1; $y -ge 0; $y--) {
      for ($x = 0; $x -lt $w; $x++) {
        $c = $bmp.GetPixel($x, $y)
        $iw.Write([Byte]$c.B); $iw.Write([Byte]$c.G); $iw.Write([Byte]$c.R); $iw.Write([Byte]$c.A)
      }
    }
    # AND mask：全 0（alpha 已在像素中）
    $maskRowBytes = [math]::Ceiling($w / 32.0) * 4
    $maskBytes = New-Object Byte[] ($maskRowBytes * $h)
    $iw.Write($maskBytes)
    $iw.Flush()
    $bytes = $ih.ToArray()
    $iw.Dispose(); $ih.Dispose()
    # 目录项
    $bw.Write([Byte]($(if ($s -ge 256) {0} else {$s})))
    $bw.Write([Byte]($(if ($s -ge 256) {0} else {$s})))
    $bw.Write([Byte]0); $bw.Write([Byte]0)
    $bw.Write([UInt16]1); $bw.Write([UInt16]32)
    $bw.Write([UInt32]$bytes.Length); $bw.Write([UInt32]$offset)
    $offset += $bytes.Length
    $data += ,$bytes
  }
  foreach ($bytes in $data) { $bw.Write($bytes) }
  $bw.Flush()
  [IO.File]::WriteAllBytes($icoPath, $ms.ToArray())
  $bw.Dispose(); $ms.Dispose()
  foreach ($bmp in $images) { $bmp.Dispose() }
  $png.Dispose()
}
New-Icon '$PNG' '$ICO'
Write-Host 'ICO generated OK'
`;

const root = path.join(__dirname, '..');
const png = path.join(root, 'build', 'icon.png').replace(/\\/g, '/');
const ico = path.join(root, 'build', 'icon.ico').replace(/\\/g, '/');

const script = psScript.replace('$PNG', png).replace('$ICO', ico);

const r = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
  { stdio: 'inherit', windowsHide: true, encoding: 'utf8' }
);

if (r.status !== 0) {
  console.error('ICO 生成失败');
  process.exit(r.status || 1);
}

// 验证
const size = fs.statSync(ico).size;
console.log(`icon.ico 生成: ${(size / 1024).toFixed(1)} KB`);
