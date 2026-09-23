$cache = Join-Path $env:USERPROFILE ".oar"
if (-not (Test-Path $cache)) {
    New-Item -ItemType Directory -Path $cache -Force | Out-Null
}

$files = @(
    @{
        name = "pp-ocrv5_mobile_det.onnx"
        url  = "https://github.com/GreatV/oar-ocr/releases/download/v0.3.0/pp-ocrv5_mobile_det.onnx"
        hash = "1eb7b4f7ab657ebd1c66d5f79bca7497f29768a2e3c15e52daecbba1a8e4a039"
    },
    @{
        name = "pp-ocrv5_mobile_rec.onnx"
        url  = "https://github.com/GreatV/oar-ocr/releases/download/v0.3.0/pp-ocrv5_mobile_rec.onnx"
        hash = "243a0f06d826761323e9045e9b113ab2c191c3aa50565585e628300b8eda0224"
    },
    @{
        name = "ppocrv5_dict.txt"
        url  = "https://github.com/GreatV/oar-ocr/releases/download/v0.3.0/ppocrv5_dict.txt"
        hash = "d1979e9f794c464c0d2e0b70a7fe14dd978e9dc644c0e71f14158cdf8342af1b"
    }
)

foreach ($item in $files) {
    $target = Join-Path $cache $item.name
    $sidecar = Join-Path $cache ".$($item.name).sha256"
    
    if ((Test-Path $target) -and (Test-Path $sidecar)) {
        $existingSidecar = (Get-Content $sidecar -Raw).Trim()
        if ($existingSidecar -eq $item.hash) {
            Write-Host "Already cached and verified: $($item.name)"
            continue
        }
    }
    
    Write-Host "Downloading $($item.name) from GitHub Releases..."
    & curl.exe -fL --progress-bar -o $target $item.url
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Failed to download $($item.name)"
        exit 1
    }
    
    $actual = (Get-FileHash -Algorithm SHA256 $target).Hash.ToLower()
    if ($actual -ne $item.hash) {
        Write-Error "SHA256 mismatch for $($item.name): expected $($item.hash), got $actual"
        Remove-Item $target -Force -ErrorAction SilentlyContinue
        exit 1
    }
    
    Set-Content -Path $sidecar -Value $item.hash -NoNewline
    Write-Host "Verified and cached: $($item.name)"
}

Write-Host "All models ready in $cache"
