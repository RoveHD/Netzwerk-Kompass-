param(
    [string]$Compiler = '',
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]*\.exe$')]
    [string]$OutputName = 'Netzwerk-Kompass-Desktop.exe'
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$zip = Join-Path $root 'dist\Netzwerk-Kompass-Windows.zip'
$source = Join-Path $PSScriptRoot 'portable-launcher.cs'
$outputDir = Join-Path $root 'dist'
$exe = Join-Path $outputDir $OutputName
$sums = Join-Path $outputDir 'SHA256SUMS.txt'

if (-not (Test-Path -LiteralPath $zip -PathType Leaf)) { throw "Portable Payload fehlt: $zip. Zuerst build-portable.ps1 ausführen." }
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Launcher-Quelltext fehlt: $source" }
if (-not $Compiler) {
    $candidate = Get-Command csc.exe -ErrorAction SilentlyContinue
    if ($candidate) { $Compiler = $candidate.Source }
    else {
        $frameworkCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
        if (-not (Test-Path -LiteralPath $frameworkCompiler)) { $frameworkCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
        if (Test-Path -LiteralPath $frameworkCompiler) { $Compiler = $frameworkCompiler }
        else { throw 'Kein vorhandener .NET Framework csc.exe Compiler gefunden. Es werden keine Downloads oder Dependencies installiert.' }
    }
}
$Compiler = (Resolve-Path -LiteralPath $Compiler).Path
[void](New-Item -ItemType Directory -Path $outputDir -Force)
$resourceArg = '/resource:' + $zip + ',NetzwerkKompass.Payload.zip'
$icon = Join-Path $root 'public\brand\compass.ico'
if (-not (Test-Path -LiteralPath $icon -PathType Leaf)) { throw "Anwendungssymbol fehlt: $icon" }
$arguments = @('/nologo', '/target:winexe', '/platform:x64', '/optimize+', ('/out:' + $exe), ('/win32icon:' + $icon), '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll', $resourceArg, $source)
& $Compiler @arguments
if ($LASTEXITCODE -ne 0) { throw "csc.exe fehlgeschlagen (Exitcode $LASTEXITCODE)." }

$zipHash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
$exeHash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
$lines = @()
if (Test-Path -LiteralPath $sums) {
    $replacePattern = '\s+(Netzwerk-Kompass-Windows\.zip|' + [Regex]::Escape($OutputName) + ')$'
    $lines = @(Get-Content -LiteralPath $sums | Where-Object { $_ -notmatch $replacePattern })
}
$lines += "$zipHash  Netzwerk-Kompass-Windows.zip"
$lines += "$exeHash  $OutputName"
Set-Content -LiteralPath $sums -Value $lines -Encoding ASCII
Write-Output "Windows-EXE: $exe"
Write-Output "SHA256: $exeHash"
