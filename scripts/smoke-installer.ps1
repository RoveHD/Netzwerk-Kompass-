param([switch]$SkipRuntime)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$target = [IO.Path]::GetFullPath((Join-Path $root 'test-artifacts\nsis-install'))
if (-not $target.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe installer test directory.' }
$uninstallRoot = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$existing = @(if (Test-Path -LiteralPath $uninstallRoot) { Get-ChildItem -LiteralPath $uninstallRoot | Get-ItemProperty | Where-Object DisplayName -like 'Netzwerk-Kompass*' })
if ($existing.Count) { throw 'Existing installation detected; refusing to replace it.' }
$links = @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Netzwerk-Kompass.lnk'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'Netzwerk-Kompass.lnk'))
foreach ($link in $links) { if (Test-Path -LiteralPath $link) { throw 'Existing shortcut detected; refusing to replace it.' } }
$data = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Netzwerk-Kompass'
$hadData = Test-Path -LiteralPath $data
[void](New-Item -ItemType Directory -Path $data -Force)
$marker = Join-Path $data ('.installer-test-' + [Guid]::NewGuid().ToString('N'))
[IO.File]::WriteAllText($marker, 'preserve-on-uninstall')
$exe = Join-Path $target 'Netzwerk-Kompass.exe'
$uninstaller = Join-Path $target 'Uninstall Netzwerk-Kompass.exe'
$installed = $false
try {
    $setup = Join-Path $root "release\Netzwerk-Kompass-Setup-$version-x64.exe"
    $process = Start-Process -FilePath $setup -ArgumentList @('/S', ('/D=' + $target)) -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Install failed: $($process.ExitCode)" }
    $installed = $true
    if (-not (Test-Path -LiteralPath $exe)) { throw 'Installed executable missing.' }
    $entries = @(Get-ChildItem $uninstallRoot | Get-ItemProperty | Where-Object DisplayName -like 'Netzwerk-Kompass*')
    if ($entries.Count -ne 1 -or $entries[0].DisplayVersion -ne $version) { throw 'Wrong Windows uninstall registration.' }
    if (-not $entries[0].UninstallString.StartsWith(('"' + $uninstaller + '"'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Uninstall command points outside isolated installation.' }
    if (-not $SkipRuntime) {
        & node (Join-Path $PSScriptRoot 'smoke-installed.mjs') $exe
        if ($LASTEXITCODE -ne 0) { throw 'Installed runtime smoke failed.' }
    }
    Write-Output 'NSIS installation and Windows registration: OK'
} finally {
    if ($installed) {
        $process = Start-Process -FilePath $uninstaller -ArgumentList @('/S', ('_?=' + $target)) -WindowStyle Hidden -Wait -PassThru
        if ($process.ExitCode -ne 0 -or (Test-Path -LiteralPath $exe)) { throw 'NSIS uninstall failed.' }
        $remaining = @(if (Test-Path -LiteralPath $uninstallRoot) { Get-ChildItem -LiteralPath $uninstallRoot | Get-ItemProperty | Where-Object DisplayName -like 'Netzwerk-Kompass*' })
        if ($remaining.Count) { throw 'Windows uninstall entry remained.' }
        if (-not (Test-Path -LiteralPath $marker)) { throw 'Uninstaller deleted user data.' }
        foreach ($link in $links) { if (Test-Path -LiteralPath $link) { throw 'Shortcut remained after uninstall.' } }
        Write-Output 'NSIS uninstall, shortcuts, registry and AppData preservation: OK'
    }
    if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force }
    if (-not $hadData -and (Test-Path -LiteralPath $data) -and @(Get-ChildItem -LiteralPath $data -Force).Count -eq 0) { Remove-Item -LiteralPath $data }
}
