param([switch]$Elevate, [string]$ElevatedPipe = '', [switch]$SelfTest,
    [string]$GuardSession = '', [string]$GuardSessionGuid = '', [int]$GuardOwnerPid = 0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    Add-Type -Path (Join-Path $PSScriptRoot 'game-packets.cs') -ReferencedAssemblies System.Web.Extensions.dll
    [GamePackets.Capture]::ScriptPath = $PSCommandPath
    if ($SelfTest) { [GamePackets.Capture]::SelfTest(); exit 0 }
    if ($GuardSession) { [GamePackets.Capture]::Guard($GuardSession, $GuardSessionGuid, $GuardOwnerPid) }
    elseif ($ElevatedPipe) { [GamePackets.Capture]::Connect($ElevatedPipe) }
    elseif ($Elevate) { [GamePackets.Capture]::Bridge($PSCommandPath) }
    else { [GamePackets.Capture]::Run([Console]::In, [Console]::Out) }
} catch {
    # Never expose process paths or arbitrary native exception contents.
    [Console]::Out.WriteLine('{"type":"error","code":"helper_failed"}')
    exit 1
}
