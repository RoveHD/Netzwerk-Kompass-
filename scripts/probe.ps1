param([ValidateSet('discover', 'traffic', 'ping', 'trace', 'worker', 'traffic-worker')][string]$Mode)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding

# Local route lookup only; no packets or administrative rights are required.
# Unsupported native lookup must not prevent Ping itself from working.
$routeLookupAvailable = $false
if ($Mode -eq 'worker' -or $Mode -eq 'ping') {
    try {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class KompassRoute {
    [DllImport("iphlpapi.dll", ExactSpelling=true)]
    public static extern uint GetBestInterface(uint destination, out uint interfaceIndex);
}
'@
        $routeLookupAvailable = $true
    } catch { $routeLookupAvailable = $false }
}

function Write-Json($value) {
    # -InputObject preserves empty and single-element arrays on Windows PowerShell 5.1.
    ConvertTo-Json -InputObject $value -Depth 10 -Compress
}

function Convert-NativeBytes([byte[]]$bytes) {
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) {
        return [System.Text.Encoding]::UTF8.GetString($bytes, 3, $bytes.Length - 3)
    }
    if ($bytes.Length -ge 2 -and $bytes[0] -eq 255 -and $bytes[1] -eq 254) {
        return [System.Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2)
    }
    if ($bytes.Length -ge 2 -and $bytes[0] -eq 254 -and $bytes[1] -eq 255) {
        return [System.Text.Encoding]::BigEndianUnicode.GetString($bytes, 2, $bytes.Length - 2)
    }
    try {
        $strictUtf8 = New-Object System.Text.UTF8Encoding($false, $true)
        return $strictUtf8.GetString($bytes)
    } catch {
        # Legacy Windows command-line tools use the active OEM code page.
        $encoding = [System.Text.Encoding]::GetEncoding([System.Globalization.CultureInfo]::CurrentCulture.TextInfo.OEMCodePage)
        return $encoding.GetString($bytes)
    }
}

function Invoke-Native([string]$file, [string]$arguments, [int]$timeout = 5000) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $file
    $info.Arguments = $arguments
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    $stdoutBytes = $null
    $stderrBytes = $null
    try {
        [void]$process.Start()
        $stdoutBytes = New-Object System.IO.MemoryStream
        $stderrBytes = New-Object System.IO.MemoryStream
        $stdoutTask = $process.StandardOutput.BaseStream.CopyToAsync($stdoutBytes)
        $stderrTask = $process.StandardError.BaseStream.CopyToAsync($stderrBytes)
        if (-not $process.WaitForExit($timeout)) {
            $process.Kill()
            throw "$file Zeitlimit erreicht."
        }
        [void]$stdoutTask.GetAwaiter().GetResult()
        [void]$stderrTask.GetAwaiter().GetResult()
        return @{ output = (Convert-NativeBytes $stdoutBytes.ToArray()); error = (Convert-NativeBytes $stderrBytes.ToArray()); code = $process.ExitCode }
    } finally {
        if ($null -ne $stdoutBytes) { $stdoutBytes.Dispose() }
        if ($null -ne $stderrBytes) { $stderrBytes.Dispose() }
        $process.Dispose()
    }
}

function Assert-Host([string]$target) {
    if ($target.Length -lt 1 -or $target.Length -gt 253 -or $target -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.\-]*$') { throw 'Ungueltiges Netzwerkziel.' }
    $address = $null
    if ([System.Net.IPAddress]::TryParse($target, [ref]$address)) {
        if ($address.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork -or $target -notmatch '^\d{1,3}(\.\d{1,3}){3}$') { throw 'Ungueltige IPv4-Adresse.' }
    } else {
        if ($target -match '^[\d.]+$') { throw 'Ungueltige IPv4-Adresse.' }
        foreach ($label in $target.Split('.')) {
            if ($label -notmatch '^[a-zA-Z0-9]([a-zA-Z0-9\-]{0,61}[a-zA-Z0-9])?$') { throw 'Ungueltiger Hostname.' }
        }
    }
}

function Invoke-PingBatch($request) {
        $targets = @($request.hosts)
        if ($targets.Count -gt 64 -or $request.timeoutMs -lt 100 -or $request.timeoutMs -gt 10000 -or $request.timeoutMs -ne [int]$request.timeoutMs) { throw 'Ungueltiger Ping-Batch.' }
        foreach ($target in $targets) { Assert-Host $target }
        $pending = @()
        foreach ($target in $targets) {
            $ping = New-Object System.Net.NetworkInformation.Ping
            $routeInterfaceId = $null
            if ($routeLookupAvailable) {
                try {
                    $routeAddress = $null
                    if ([System.Net.IPAddress]::TryParse([string]$target, [ref]$routeAddress) -and $routeAddress.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork) {
                        [uint32]$routeIndex = 0
                        if ([KompassRoute]::GetBestInterface([BitConverter]::ToUInt32($routeAddress.GetAddressBytes(),0), [ref]$routeIndex) -eq 0) { $routeInterfaceId = [string]$routeIndex }
                    }
                } catch { $routeInterfaceId = $null }
            }
            try {
                $task = $ping.SendPingAsync([string]$target, [int]$request.timeoutMs)
                $pending += @{ host = $target; ping = $ping; task = $task; error = $null; routeInterfaceId = $routeInterfaceId }
            } catch { $pending += @{ host = $target; ping = $ping; task = $null; error = $_.Exception.GetBaseException().Message; routeInterfaceId = $routeInterfaceId } }
        }
        $results = @()
        foreach ($item in $pending) {
            try {
                if ($null -eq $item.task) { throw $item.error }
                $reply = $item.task.GetAwaiter().GetResult()
                $success = $reply.Status -eq [System.Net.NetworkInformation.IPStatus]::Success
                $ms = $null
                if ($success) { $ms = $reply.RoundtripTime }
                $results += @{ host = $item.host; ok = $success; ms = $ms; status = $reply.Status.ToString(); routeInterfaceId = $item.routeInterfaceId }
            } catch { $results += @{ host = $item.host; ok = $false; ms = $null; status = 'measurement_error'; error = $_.Exception.GetBaseException().Message } }
            finally { $item.ping.Dispose() }
        }
        return ,@($results)
}

# Native .NET counters are local reads. This deliberately uses neither CIM nor
# a new subprocess on each sample and runs independently of the Ping worker.
function Get-TrafficCounters {
    $counters = @()
    foreach ($adapter in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
        if ($adapter.NetworkInterfaceType -eq 'Loopback') { continue }
        try {
            $ipv4 = $adapter.GetIPProperties().GetIPv4Properties()
            if ($null -eq $ipv4) { continue }
            $index = $ipv4.Index
        } catch { continue } # An IPv6-only adapter has no IPv4 interface index.
        $stats = $adapter.GetIPv4Statistics()
        $speed = $null
        try { if ($adapter.Speed -gt 0) { $speed = $adapter.Speed / 1000000 } } catch { }
        $counters += @{ id = [string]$index; name = $adapter.Name; receivedBytes = $stats.BytesReceived; sentBytes = $stats.BytesSent;
            receivedErrors = $stats.IncomingPacketsWithErrors; sentErrors = $stats.OutgoingPacketsWithErrors;
            receivedDiscards = $stats.IncomingPacketsDiscarded; sentDiscards = $stats.OutgoingPacketsDiscarded;
            status = $adapter.OperationalStatus.ToString(); linkSpeedMbps = $speed }
        if ($counters.Count -gt 256) { throw 'Zu viele Netzwerkschnittstellen fuer eine Verkehrsmessung.' }
    }
    return ,@($counters)
}

try {
    if ($Mode -eq 'traffic-worker') {
        while ($null -ne ($line = [Console]::In.ReadLine())) {
            if ($line.Length -gt 1024) { throw 'Verkehrsmessanfrage ist zu gross.' }
            $request = $line | ConvertFrom-Json
            if ($request.requestId -notmatch '^[1-9][0-9]{0,14}$') { throw 'Ungueltige Verkehrsmessanfrage.' }
            $counters = Get-TrafficCounters
            [Console]::Out.WriteLine((ConvertTo-Json -InputObject @{ requestId = [string]$request.requestId; counters = $counters } -Depth 10 -Compress))
            [Console]::Out.Flush()
        }
        exit 0
    }
    if ($Mode -eq 'worker') {
        while ($null -ne ($line = [Console]::In.ReadLine())) {
            if ($line.Length -gt 65536) { throw 'Ping-Anfrage ist zu gross.' }
            $request = $line | ConvertFrom-Json
            $results = Invoke-PingBatch $request
            [Console]::Out.WriteLine((ConvertTo-Json -InputObject $results -Depth 10 -Compress))
            [Console]::Out.Flush()
        }
        exit 0
    }
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($Mode -eq 'ping') {
        Write-Json (Invoke-PingBatch $request)
    } elseif ($Mode -eq 'trace') {
        Assert-Host $request.host
        # Host is validated before passing a native argument; no expression evaluation.
        $trace = Invoke-Native "$env:SystemRoot\System32\tracert.exe" "-d -h 16 -w 400 $($request.host)" 22000
        Write-Json @{ host = $request.host; output = ($trace.output + $trace.error) }
    } elseif ($Mode -eq 'traffic') {
        Write-Json (Get-TrafficCounters)
    } else {
        $interfaces = @()
        $warnings = @()
        foreach ($adapter in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
            if ($adapter.OperationalStatus -ne 'Up' -or $adapter.NetworkInterfaceType -eq 'Loopback') { continue }
            $props = $adapter.GetIPProperties()
            $addresses = @($props.UnicastAddresses | Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' })
            if ($addresses.Count -eq 0) { continue }
            $index = $props.GetIPv4Properties().Index
            $ipv4 = @()
            foreach ($addr in $addresses) {
                # PrefixLength is absent in .NET Framework; count mask bits there.
                $prefix = 0
                foreach ($byte in $addr.IPv4Mask.GetAddressBytes()) {
                    for ($bit = 7; $bit -ge 0; $bit--) { if ($byte -band (1 -shl $bit)) { $prefix++ } }
                }
                $ipv4 += @{ address = $addr.Address.ToString(); prefixLength = $prefix }
            }
            $gateways = @($props.GatewayAddresses | Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' -and $_.Address.ToString() -ne '0.0.0.0' })
            $gateway = $null
            if ($gateways.Count -gt 0) { $gateway = $gateways[0].Address.ToString() }
            $kind = 'ethernet'
            if ($adapter.NetworkInterfaceType -eq 'Wireless80211') { $kind = 'wifi' }
            elseif ($adapter.NetworkInterfaceType -in @('Tunnel', 'Ppp') -or ($adapter.Name + ' ' + $adapter.Description) -match '(?i)vpn|wireguard|tailscale|tap-windows|wintun') { $kind = 'vpn' }
            $speed = $null
            if ($adapter.Speed -gt 0) { $speed = $adapter.Speed / 1000000 }
            $interfaces += @{ id = [string]$index; name = $adapter.Name; description = $adapter.Description; ipv4 = @($ipv4); gateway = $gateway;
                dns = @($props.DnsAddresses | ForEach-Object { $_.ToString() }); mac = (($adapter.GetPhysicalAddress().GetAddressBytes() | ForEach-Object { $_.ToString('X2') }) -join ':'); status = 'Up'; kind = $kind; linkSpeedMbps = $speed }
        }
        $defaultId = $null
        try {
            $ipInterfaces = @(Get-NetIPInterface -AddressFamily IPv4 -ErrorAction Stop)
            $routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop | Where-Object { $_.InterfaceIndex.ToString() -in $interfaces.id })
            $ranked = @($routes | Sort-Object @{ Expression = {
                $route = $_
                $metric = @($ipInterfaces | Where-Object { $_.InterfaceIndex -eq $route.InterfaceIndex })[0].InterfaceMetric
                [long]$route.RouteMetric + [long]$metric
            } }, InterfaceIndex)
            if ($ranked.Count -gt 0) { $defaultId = [string]$ranked[0].InterfaceIndex }
        } catch {
            $warnings += 'Standardroute und Metrik konnten nicht gelesen werden. Auswahl anhand vorhandener Gateways ist nur eine Schaetzung.'
            $candidates = @($interfaces | Where-Object { $null -ne $_.gateway })
            if ($candidates.Count -eq 1) { $defaultId = $candidates[0].id }
        }
        $neighbors = @()
        $neighborFallback = ''
        try {
            foreach ($neighbor in @(Get-NetNeighbor -AddressFamily IPv4 -ErrorAction Stop)) {
                if ($neighbor.InterfaceIndex.ToString() -notin $interfaces.id) { continue }
                $neighbors += @{ ip = $neighbor.IPAddress; mac = $neighbor.LinkLayerAddress; state = $neighbor.State.ToString(); interfaceId = [string]$neighbor.InterfaceIndex }
            }
        } catch {
            $warnings += 'Nachbartabelle konnte nicht gelesen werden (Windows-Zugriffsrechte oder Dienst nicht verfuegbar).'
            try {
                $arp = Invoke-Native "$env:SystemRoot\System32\arp.exe" '-a'
                if ($arp.code -eq 0) {
                    $neighborFallback = $arp.output
                    $warnings += 'Nachbarn stammen ersatzweise aus dem vorhandenen ARP-Cache; Eintraege koennen veraltet sein und beweisen keine Erreichbarkeit.'
                }
            } catch { $warnings += 'Auch der vorhandene ARP-Cache konnte nicht gelesen werden.' }
        }
        $wifiInterfaces = ''; $wifiNetworks = ''; $wifiFailure = $null
        try {
            $wlan = Invoke-Native "$env:SystemRoot\System32\netsh.exe" 'wlan show interfaces'
            $wifiInterfaces = $wlan.output
            if ($wlan.code -ne 0) { $wifiFailure = ($wlan.output + $wlan.error).Trim() }
            else {
                $scan = Invoke-Native "$env:SystemRoot\System32\netsh.exe" 'wlan show networks mode=bssid'
                $wifiNetworks = $scan.output
                if ($scan.code -ne 0) { $wifiFailure = ($scan.output + $scan.error).Trim() }
            }
        } catch { $wifiFailure = $_.Exception.Message }
        Write-Json @{ interfaces = @($interfaces); defaultInterfaceId = $defaultId; neighbors = @($neighbors);
            neighborFallback = $neighborFallback; wifiInterfaces = $wifiInterfaces; wifiNetworks = $wifiNetworks; wifiError = $wifiFailure; warnings = @($warnings) }
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
    exit 1
}
