param(
    [string]$NodePath = (Get-Command node.exe -ErrorAction Stop).Source,
    [string]$ElectronPath = (Join-Path $PSScriptRoot '..\runtime\electron')
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
# Build in a fresh directory: the unpacked portable app may currently be running.
$destination = Join-Path $root ('dist\build-' + [Guid]::NewGuid().ToString('N'))
[void](New-Item -ItemType Directory -Path $destination -Force)
$electronVersion = (Get-Content -LiteralPath (Join-Path $ElectronPath 'version') -Raw).Trim()
$expectedElectronVersion = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).config.electronVersion
if ($electronVersion -ne $expectedElectronVersion) { throw "Electron-Version $electronVersion passt nicht zur festgelegten Version $expectedElectronVersion." }
$relativeFiles = @('server.js', 'package.json', 'README.md', 'Netzwerk-Kompass-starten.cmd', 'scripts\probe.ps1', 'scripts\games.ps1', 'scripts\game-packets.ps1', 'scripts\game-packets.cs', 'scripts\secret-store.ps1', 'runtime\node.exe', 'runtime\NODE-LICENSE.txt', 'runtime\NODE-VERSION.txt')
foreach ($folder in @('docs', 'lib', 'public', 'public\brand', 'public\fonts', 'desktop', 'scripts', 'runtime', 'runtime\electron', 'runtime\electron\locales', 'runtime\electron\resources')) {
    [void](New-Item -ItemType Directory -Path (Join-Path $destination $folder) -Force)
}
foreach ($file in @('server.js', 'package.json', 'README.md', 'Netzwerk-Kompass-starten.cmd')) {
    Copy-Item -LiteralPath (Join-Path $root $file) -Destination $destination -Force
}
Get-ChildItem -LiteralPath (Join-Path $root 'lib') -Filter '*.js' | Copy-Item -Destination (Join-Path $destination 'lib') -Force
$relativeFiles += 'docs\ursachenanalyse.md'
Copy-Item -LiteralPath (Join-Path $root 'docs\ursachenanalyse.md') -Destination (Join-Path $destination 'docs\ursachenanalyse.md') -Force
$relativeFiles += @(Get-ChildItem -LiteralPath (Join-Path $root 'lib') -Filter '*.js' -File | ForEach-Object { 'lib\' + $_.Name })
foreach ($file in @('incident-view.js', 'incident-view.css', 'diagnostic-settings.js', 'diagnostic-settings.css', 'peer-monitor.js', 'peer-monitor.css', 'background-monitor.js', 'overview-details.js', 'dashboard.css', 'live-signal.js', 'live-signal.css', 'ui-presentation.js', 'ui-help.js', 'graphite.css', 'workspace.css', 'workspace-panels.css', 'network-health.js', 'network-health.css', 'game-comparison.js', 'game-comparison.css', 'lag-incidents.js', 'lag-incidents.css', 'index.html', 'style.css', 'app.js', 'games.js', 'games.css', 'overview.js', 'overview.css', 'fritzbox.js', 'ai.js', 'diagnosis-result.js', 'diagnosis-result.css', 'navigation.js', 'lag-hotkey.js', 'history-selection.js', 'ping-chart.js', 'ping-chart.css', 'ping-statistics.js', 'traffic-history.js', 'storage.js', 'scroll-state.js', 'speedtest-ui.js', 'speed-history.js', 'speedtest-options.js', 'stress-test-ui.js', 'speedtest.css', 'topology.js', 'topology.css')) {
    Copy-Item -LiteralPath (Join-Path $root ('public\' + $file)) -Destination (Join-Path $destination 'public') -Force
    $relativeFiles += 'public\' + $file
}
foreach ($file in @('compass.png', 'compass-256.png', 'compass-64.png', 'compass.ico')) {
    $relative = 'public\brand\' + $file
    Copy-Item -LiteralPath (Join-Path $root $relative) -Destination (Join-Path $destination $relative) -Force
    $relativeFiles += $relative
}
foreach ($file in @('geist-variable.woff2', 'geist-mono-variable.woff2', 'LICENSE-Geist.txt', 'README.md')) {
    $relative = 'public\fonts\' + $file
    Copy-Item -LiteralPath (Join-Path $root $relative) -Destination (Join-Path $destination $relative) -Force
    $relativeFiles += $relative
}
foreach ($file in @('main.cjs', 'policy.cjs', 'preload.cjs', 'lag-hotkey.cjs', 'native-hotkey.cjs', 'background.cjs', 'background-server.cjs', 'server-lifecycle.cjs')) {
    Copy-Item -LiteralPath (Join-Path $root ('desktop\' + $file)) -Destination (Join-Path $destination 'desktop') -Force
    $relativeFiles += 'desktop\' + $file
}
# Only vendor runtime files, including Electron's script entrypoint loader.
$electronFiles = @('chrome_100_percent.pak','chrome_200_percent.pak','d3dcompiler_47.dll','dxcompiler.dll','dxil.dll','ffmpeg.dll','icudtl.dat','LICENSE','LICENSES.chromium.html','resources.pak','snapshot_blob.bin','v8_context_snapshot.bin','version','vk_swiftshader_icd.json','vk_swiftshader.dll','vulkan-1.dll','locales\de.pak','locales\en-US.pak','resources\default_app.asar')
foreach ($file in $electronFiles) {
    $relative = 'runtime\electron\' + $file
    Copy-Item -LiteralPath (Join-Path $ElectronPath $file) -Destination (Join-Path $destination $relative) -Force
    $relativeFiles += $relative
}
$desktopExecutable = 'runtime\electron\Netzwerk-Kompass-Desktop.exe'
Copy-Item -LiteralPath (Join-Path $ElectronPath 'electron.exe') -Destination (Join-Path $destination $desktopExecutable) -Force
$relativeFiles += $desktopExecutable
Copy-Item -LiteralPath (Join-Path $root 'scripts\probe.ps1') -Destination (Join-Path $destination 'scripts') -Force
foreach ($gameScript in @('games.ps1', 'game-packets.ps1', 'game-packets.cs', 'lag-hotkey.ps1', 'lag-hotkey.cs', 'secret-store.ps1')) {
    Copy-Item -LiteralPath (Join-Path $root ('scripts\' + $gameScript)) -Destination (Join-Path $destination 'scripts') -Force
    if ($gameScript.StartsWith('lag-hotkey.')) { $relativeFiles += 'scripts\' + $gameScript }
}
Copy-Item -LiteralPath $NodePath -Destination (Join-Path $destination 'runtime\node.exe') -Force
$version = (& $NodePath --version).Trim()
if ($version -notmatch '^v\d+\.\d+\.\d+$') { throw 'Unerwartete Node-Version.' }
$licensePath = Join-Path $destination 'runtime\NODE-LICENSE.txt'
$licenseVersionPath = Join-Path $destination 'runtime\NODE-VERSION.txt'
$cachedRuntime = Join-Path $root 'dist\Netzwerk-Kompass\runtime'
if ((Test-Path -LiteralPath (Join-Path $cachedRuntime 'NODE-LICENSE.txt')) -and (Test-Path -LiteralPath (Join-Path $cachedRuntime 'NODE-VERSION.txt')) -and (Get-Content -LiteralPath (Join-Path $cachedRuntime 'NODE-VERSION.txt') -Raw).Trim() -eq $version) {
    Copy-Item -LiteralPath (Join-Path $cachedRuntime 'NODE-LICENSE.txt') -Destination $licensePath
    Copy-Item -LiteralPath (Join-Path $cachedRuntime 'NODE-VERSION.txt') -Destination $licenseVersionPath
}
if (-not (Test-Path -LiteralPath $licensePath) -or -not (Test-Path -LiteralPath $licenseVersionPath) -or (Get-Content -LiteralPath $licenseVersionPath -Raw).Trim() -ne $version) {
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/nodejs/node/$version/LICENSE" -OutFile $licensePath -UseBasicParsing
}
if ((Get-Item -LiteralPath $licensePath).Length -lt 1000) { throw 'Node-Lizenz fehlt oder ist unvollstaendig.' }
Set-Content -LiteralPath $licenseVersionPath -Value $version -Encoding ASCII
$zip = Join-Path $root 'dist\Netzwerk-Kompass-Windows.zip'
# Package an explicit file list; a previously used portable folder may contain private data.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipStream = [IO.File]::Open($zip, [IO.FileMode]::Create)
try {
    $archive = New-Object IO.Compression.ZipArchive($zipStream, [IO.Compression.ZipArchiveMode]::Create, $true)
    try {
        foreach ($relative in $relativeFiles) {
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, (Join-Path $destination $relative), $relative.Replace('\','/'), [IO.Compression.CompressionLevel]::Optimal)
        }
    } finally { $archive.Dispose() }
} finally { $zipStream.Dispose() }
$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
Set-Content -LiteralPath (Join-Path $root 'dist\SHA256SUMS.txt') -Value "$hash  Netzwerk-Kompass-Windows.zip" -Encoding ASCII
Write-Output "Portable Ausgabe: $zip"
Write-Output "Node-Laufzeit: $version"
Write-Output "Desktop-Laufzeit: Electron $electronVersion"
Write-Output "SHA256: $hash"
# Only remove this invocation's generated staging directory, never an active app.
$stagingPath = [IO.Path]::GetFullPath($destination)
$distRoot = [IO.Path]::GetFullPath((Join-Path $root 'dist')) + [IO.Path]::DirectorySeparatorChar
if (-not $stagingPath.StartsWith($distRoot, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($stagingPath) -notmatch '^build-[a-f0-9]{32}$') { throw 'Unerwarteter Staging-Pfad; wird nicht entfernt.' }
Remove-Item -LiteralPath $stagingPath -Recurse -Force
