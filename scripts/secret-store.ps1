param([ValidateSet('protect', 'unprotect')][string]$Operation)
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Security
    # Only pipes carry plaintext (base64); no temporary file or command argument.
    $inputBuffer = New-Object char[] 100001
    $length = 0
    while ($length -lt $inputBuffer.Length) {
        $read = [Console]::In.Read($inputBuffer, $length, $inputBuffer.Length - $length)
        if ($read -eq 0) { break }
        $length += $read
    }
    if ($length -eq 0 -or $length -ge $inputBuffer.Length) { throw 'Invalid input size' }
    $bytes = [Convert]::FromBase64String([string]::new($inputBuffer, 0, $length))
    if ($bytes.Length -gt 73728) { throw 'Invalid input size' }
    $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    $entropy = [System.Text.Encoding]::UTF8.GetBytes('Netzwerk-Kompass secrets v1')
    if ($Operation -eq 'protect') {
        $result = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope)
    } else {
        $result = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, $scope)
    }
    [Console]::Out.Write([Convert]::ToBase64String($result))
    [Array]::Clear($bytes, 0, $bytes.Length)
    [Array]::Clear($result, 0, $result.Length)
} catch {
    [Console]::Error.Write('Windows secret protection failed.')
    exit 1
}
