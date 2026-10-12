param([string]$Root, [string]$Temporary)
$ErrorActionPreference = 'Stop'

# Load only the production download function, without running runtime setup.
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $Root 'scripts/prepare-runtime.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw $parseErrors[0] }
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-VerifiedDownload' }, $true)
if (-not $function) { throw 'Production download function missing.' }
. ([scriptblock]::Create($function.Extent.Text))

$script:payload = [Text.Encoding]::UTF8.GetBytes('isolated runtime download fixture')
$hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($script:payload)).ToLowerInvariant()
$script:downloads = 0
function Invoke-WebRequest {
    param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
    if ($OutFile) {
        if ($Uri -ne 'https://fixture.invalid/runtime') { throw 'Unexpected download URL.' }
        $script:downloads++
        [IO.File]::WriteAllBytes($OutFile, $script:payload)
    } else {
        if ($Uri -ne 'https://fixture.invalid/SHASUMS256.txt') { throw 'Unexpected checksum URL.' }
        [pscustomobject]@{ Content = $script:content }
    }
}

$entry = 'electron-v44.3.0-win32-x64.zip'
$line = "$hash *$entry"
$cases = @(
    @{ Name = 'text'; Content = "$line`n"; Entry = $entry; Downloads = 1 },
    @{ Name = 'github-binary'; Content = [Text.Encoding]::UTF8.GetBytes("$hash *another-file.zip`n$line`n"); Entry = $entry; Downloads = 1 },
    @{ Name = 'bom-crlf'; Content = [byte[]]([Text.Encoding]::UTF8.GetPreamble() + [Text.Encoding]::UTF8.GetBytes("$line`r`n")); Entry = $entry; Downloads = 1 },
    @{ Name = 'node-path'; Content = "$hash  win-x64/node.exe`n"; Entry = 'win-x64/node.exe'; Downloads = 1 },
    @{ Name = 'duplicate'; Content = "$line`n$line`n"; Entry = $entry; Error = '*Keine eindeutige*'; Downloads = 0 },
    @{ Name = 'missing'; Content = "$hash *electron-v44.3.0-win32-arm64.zip`n"; Entry = $entry; Error = '*Keine eindeutige*'; Downloads = 0 },
    @{ Name = 'wrong-hash'; Content = ('0' * 64) + " *$entry`n"; Entry = $entry; Error = '*SHA256 stimmt nicht*'; Downloads = 1 },
    @{ Name = 'invalid-utf8'; Content = [byte[]]@(0xff, 0xff); Entry = $entry; Error = '*'; ErrorType = [Text.DecoderFallbackException]; Downloads = 0 },
    @{ Name = 'unexpected-response'; Content = 42; Entry = $entry; Error = '*Unerwartetes Antwortformat*'; Downloads = 0 }
)
$passed = foreach ($case in $cases) {
    $script:content = $case.Content; $script:downloads = 0
    $destination = Join-Path $Temporary ($case.Name + '.download')
    $failure = $null
    try { Get-VerifiedDownload 'https://fixture.invalid/runtime' 'https://fixture.invalid/SHASUMS256.txt' $case.Entry $destination } catch { $failure = $_ }
    if ($case.Error) {
        if (-not $failure -or $failure.ToString() -notlike $case.Error) { throw "Case $($case.Name): expected rejection, got $failure" }
        if ($case.ErrorType -and -not $case.ErrorType.IsInstanceOfType($failure.Exception.GetBaseException())) { throw "Case $($case.Name): unexpected exception type." }
    } elseif ($failure) { throw "Case $($case.Name) failed: $failure" }
    if ($script:downloads -ne $case.Downloads) { throw "Case $($case.Name): unexpected download count." }
    if (-not $case.Error -and (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw 'Downloaded bytes differ.' }
    $case.Name
}
@{ passed = @($passed) } | ConvertTo-Json -Compress
