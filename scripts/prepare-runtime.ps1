param()
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime = Join-Path $root 'runtime'
$package = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
$nodeVersion = $package.config.nodeVersion
$electronVersion = $package.config.electronVersion
foreach ($version in @($nodeVersion, $electronVersion)) {
    if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Ungueltige festgelegte Runtime-Version.' }
}
[void](New-Item -ItemType Directory -Path $runtime -Force)

function Get-VerifiedDownload([string]$Url, [string]$SumsUrl, [string]$Entry, [string]$Destination) {
    $content = (Invoke-WebRequest -Uri $SumsUrl -UseBasicParsing).Content
    # GitHub serves SHASUMS256.txt as application/octet-stream. PowerShell 7
    # returns byte[] for that response, whereas text/plain is returned as string.
    if ($content -is [byte[]]) {
        $sums = [Text.UTF8Encoding]::new($false, $true).GetString($content)
    } elseif ($content -is [string]) {
        $sums = $content
    } else {
        throw "Unerwartetes Antwortformat der offiziellen SHA256-Pruefsummen fuer $Entry."
    }
    $sums = $sums.TrimStart([char]0xFEFF)
    $line = @($sums -split "`n" | Where-Object { $_.Trim() -match ('^[a-fA-F0-9]{64}\s+\*?' + [Regex]::Escape($Entry) + '$') })
    if ($line.Count -ne 1) { throw "Keine eindeutige offizielle SHA256-Pruefsumme fuer $Entry." }
    $expected = ($line[0].Trim() -split '\s+')[0]
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ne $expected) { throw "SHA256 stimmt nicht: $Entry" }
}

$node = Join-Path $runtime 'node.exe'
$existingNodeVersion = if (Test-Path -LiteralPath $node) { (& $node --version).Trim() } else { '' }
if ($existingNodeVersion -ne "v$nodeVersion") {
    $base = "https://nodejs.org/dist/v$nodeVersion"
    $temporaryNode = Join-Path $runtime ('node-' + [Guid]::NewGuid().ToString('N') + '.download')
    Get-VerifiedDownload "$base/win-x64/node.exe" "$base/SHASUMS256.txt" 'win-x64/node.exe' $temporaryNode
    Move-Item -LiteralPath $temporaryNode -Destination $node -Force
}
$license = Join-Path $runtime 'NODE-LICENSE.txt'
$versionFile = Join-Path $runtime 'NODE-VERSION.txt'
if (-not (Test-Path -LiteralPath $license) -or -not (Test-Path -LiteralPath $versionFile) -or (Get-Content -LiteralPath $versionFile -Raw).Trim() -ne "v$nodeVersion") {
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/nodejs/node/v$nodeVersion/LICENSE" -OutFile $license -UseBasicParsing
}
if ((Get-Item -LiteralPath $license).Length -lt 1000) { throw 'Unvollstaendige Node-Lizenz.' }
Set-Content -LiteralPath $versionFile -Value "v$nodeVersion" -Encoding ASCII

$electron = Join-Path $runtime 'electron'
$electronVersionFile = Join-Path $electron 'version'
if (-not (Test-Path -LiteralPath $electronVersionFile) -or (Get-Content -LiteralPath $electronVersionFile -Raw).Trim() -ne $electronVersion) {
    $file = "electron-v$electronVersion-win32-x64.zip"
    $base = "https://github.com/electron/electron/releases/download/v$electronVersion"
    $archive = Join-Path $runtime $file
    Get-VerifiedDownload "$base/$file" "$base/SHASUMS256.txt" $file $archive
    Expand-Archive -LiteralPath $archive -DestinationPath $electron -Force
    Set-Content -LiteralPath $electronVersionFile -Value $electronVersion -Encoding ASCII
    Remove-Item -LiteralPath $archive -Force
}
# Old development copies of the portable window executable are not vendor files.
$legacyCopy = Join-Path $electron 'Netzwerk-Kompass-Desktop.exe'
if (Test-Path -LiteralPath $legacyCopy) { Remove-Item -LiteralPath $legacyCopy -Force }
Write-Output "Runtime bereit: Node $nodeVersion, Electron $electronVersion (Windows x64)."
