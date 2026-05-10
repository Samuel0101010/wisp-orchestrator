# Resize all *.jpg in apps/dashboard-web/public/avatars/ to 256x256 (square,
# centre-cropped) using System.Drawing. No external dependencies.
#
# Run after download-avatars.mjs:  powershell -File scripts/resize-avatars.ps1

Add-Type -AssemblyName System.Drawing

$dir = Join-Path $PSScriptRoot '..\apps\dashboard-web\public\avatars'
$dir = (Resolve-Path $dir).Path
Write-Host "resizing avatars in $dir"

$files = Get-ChildItem -Path $dir -Filter '*.jpg'
foreach ($f in $files) {
  try {
    $img = [System.Drawing.Image]::FromFile($f.FullName)
    # Square centre crop.
    $side = [Math]::Min($img.Width, $img.Height)
    $sx = [int](($img.Width  - $side) / 2)
    $sy = [int](($img.Height - $side) / 2)
    $bmp = New-Object System.Drawing.Bitmap 256, 256
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $srcRect = New-Object System.Drawing.Rectangle $sx, $sy, $side, $side
    $dstRect = New-Object System.Drawing.Rectangle 0, 0, 256, 256
    $g.DrawImage($bmp.Clone(), $dstRect)  # placeholder line — overwritten below
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($img, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
    $g.Dispose()
    $img.Dispose()

    # Encode as JPEG quality 85.
    $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
    $params = New-Object System.Drawing.Imaging.EncoderParameters 1
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 85L

    $tmp = $f.FullName + '.tmp.jpg'
    $bmp.Save($tmp, $codec, $params)
    $bmp.Dispose()
    Move-Item -Path $tmp -Destination $f.FullName -Force
    $size = (Get-Item $f.FullName).Length
    Write-Host ("  [ok] {0,-22}  {1,6:N0} KB" -f $f.Name, ($size / 1024))
  } catch {
    Write-Warning "FAILED $($f.Name): $_"
  }
}
Write-Host "done"
