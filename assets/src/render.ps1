# Рендер картинок для каталога PulseSync из HTML (нужен Microsoft Edge).
# Запуск из папки crossfade-dj:  powershell -ExecutionPolicy Bypass -File assets\src\render.ps1
# Перед рендером превью: node build.js  и  node assets\src\make-demo-data.js
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
$root = (Get-Location).Path
$prof = Join-Path $env:TEMP "crossfade-dj-render"
$jobs = @(
    @{ html = "icon.html";    out = "image.png";   w = 512;  h = 512 },
    @{ html = "banner.html";  out = "banner.png";  w = 2150; h = 550 },
    @{ html = "preview.html"; out = "preview.png"; w = 1920; h = 1080 }
)
foreach ($j in $jobs) {
    $src = Join-Path $root ("assets\src\" + $j.html)
    if (-not (Test-Path $src)) { continue }
    $out = Join-Path $root ("assets\" + $j.out)
    $url = "file:///" + ($src -replace '\\', '/')
    $args = @("--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--user-data-dir=`"$prof`"",
              "--allow-file-access-from-files", "--virtual-time-budget=6000", "--force-device-scale-factor=1",
              "--window-size=$($j.w),$($j.h)", "--screenshot=`"$out`"", "`"$url`"")
    Start-Process -FilePath $edge -ArgumentList $args -Wait -NoNewWindow | Out-Null
    "$($j.out): $([math]::Round((Get-Item $out).Length / 1024)) KB"
}
