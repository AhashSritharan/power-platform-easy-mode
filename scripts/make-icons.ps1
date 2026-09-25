# Generates the extension icons (rounded blue tile + lightning bolt).
# Run: pwsh scripts/make-icons.ps1
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot '..\extension\icons'
New-Item -ItemType Directory -Force $outDir | Out-Null

function New-Icon([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'

    # Rounded-rect tile with a diagonal Power-Platform-blue gradient
    $radius = [Math]::Max(2, $size * 0.22)
    $rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($size - $d, 0, $d, $d, 270, 90)
    $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    $path.AddArc(0, $size - $d, $d, $d, 90, 90)
    $path.CloseFigure()

    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect,
        [System.Drawing.Color]::FromArgb(255, 15, 108, 189),
        [System.Drawing.Color]::FromArgb(255, 71, 158, 245),
        45)
    $g.FillPath($brush, $path)

    # Lightning bolt (unit coordinates scaled to the tile)
    $unit = @(
        @(0.58, 0.10), @(0.28, 0.56), @(0.47, 0.56),
        @(0.42, 0.90), @(0.74, 0.42), @(0.53, 0.42)
    )
    $points = $unit | ForEach-Object {
        New-Object System.Drawing.PointF(($_[0] * $size), ($_[1] * $size))
    }
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $g.FillPolygon($white, [System.Drawing.PointF[]]$points)

    $g.Dispose()
    $file = Join-Path $outDir "icon$size.png"
    $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "wrote $file"
}

foreach ($size in 16, 32, 48, 128) { New-Icon $size }
