param([switch]$SelfTest)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'lag-hotkey.cs') -ReferencedAssemblies System.Windows.Forms.dll,System.Web.Extensions.dll
    if ($SelfTest) { [LagHotkey.Observer]::SelfTest(); exit 0 }
    [LagHotkey.Observer]::Run()
} catch {
    [Console]::Out.WriteLine('{"type":"error"}')
    exit 1
}
