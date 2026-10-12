param()
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$version = $package.version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Nur stabile Release-Versionen werden veroeffentlicht.' }
$builder = Get-Content -LiteralPath (Join-Path $root 'electron-builder.json') -Raw | ConvertFrom-Json
if ($builder.electronVersion -ne $package.config.electronVersion) { throw 'Electron-Versionen stimmen nicht ueberein.' }
$release = Join-Path $root 'release'
[void](New-Item -ItemType Directory -Path $release -Force)
Push-Location $root
try {
    & (Join-Path $PSScriptRoot 'prepare-runtime.ps1')
    & (Join-Path $PSScriptRoot 'build-portable.ps1') -NodePath (Join-Path $root 'runtime\node.exe')
    $portable = "Netzwerk-Kompass-Portable-$version-x64.exe"
    & (Join-Path $PSScriptRoot 'build-exe.ps1') -OutputName $portable
    Copy-Item -LiteralPath (Join-Path $root "dist\$portable") -Destination (Join-Path $release $portable) -Force
    & npm.cmd run build:installer
    if ($LASTEXITCODE -ne 0) { throw "Installer-Build fehlgeschlagen: $LASTEXITCODE" }
    $artifacts = @($portable, "Netzwerk-Kompass-Setup-$version-x64.exe", "Netzwerk-Kompass-Setup-$version-x64.exe.blockmap", 'latest.yml')
    $sums = foreach ($file in $artifacts) {
        $full = Join-Path $release $file
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { throw "Release-Datei fehlt: $file" }
        if ((Get-Item -LiteralPath $full).Length -eq 0) { throw "Release-Datei leer: $file" }
        (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $file
    }
    Set-Content -LiteralPath (Join-Path $release 'SHA256SUMS.txt') -Value $sums -Encoding ASCII
    & node (Join-Path $PSScriptRoot 'verify-release.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Release-Pruefung fehlgeschlagen.' }
    Write-Output "Release $version bereit in $release"
} finally { Pop-Location }
