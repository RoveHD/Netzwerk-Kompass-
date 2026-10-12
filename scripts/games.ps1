$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
# Read only: no WMI, command lines, window titles or game/network changes.
$steamRoots = @()
foreach ($key in @('HKCU:\Software\Valve\Steam', 'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam', 'HKLM:\SOFTWARE\Valve\Steam')) {
    try {
        $entry = Get-ItemProperty -LiteralPath $key -ErrorAction Stop
        foreach ($property in @('SteamPath', 'InstallPath')) {
            $value = $entry.$property
            if ($value -is [string] -and $value.Length -le 1024) { $steamRoots += $value }
        }
    } catch { }
}
foreach ($root in @(${env:ProgramFiles(x86)}, $env:ProgramFiles)) {
    if ($root) { $steamRoots += (Join-Path $root 'Steam') }
}
$epicRoots = @()
if ($env:ProgramData) { $epicRoots += (Join-Path $env:ProgramData 'Epic\EpicGamesLauncher\Data\Manifests') }
$processes = @()
$partial = $false
$all = @(Get-Process -ErrorAction Stop | Where-Object { $_.Id -gt 0 })
foreach ($process in ($all | Select-Object -First 4096)) {
    $processPath = $null
    $started = $null
    try { $processPath = $process.Path } catch { }
    try { $started = $process.StartTime.ToUniversalTime().ToString('o') } catch { }
    if (-not $processPath -or -not $started) { $partial = $true }
    $processes += @{ id = $process.Id; name = $process.ProcessName; path = $processPath; startedAt = $started }
}
ConvertTo-Json -InputObject @{ processes = $processes; steamRoots = @($steamRoots | Select-Object -Unique); epicRoots = $epicRoots; partial = $partial; truncated = ($all.Count -gt 4096) } -Depth 5 -Compress
