# Agent Harness dashboard launcher (Windows)
# Idempotent: re-running picks a free port and writes a fresh state.json.
# requires-exec: PowerShell execution; invoke via -ExecutionPolicy Bypass.

$ErrorActionPreference = 'Stop'

# Resolve plugin root (set by Claude Code) with a sensible local-dev fallback.
$pluginRoot = $env:CLAUDE_PLUGIN_ROOT
if ([string]::IsNullOrEmpty($pluginRoot)) {
    $pluginRoot = Split-Path -Parent $PSScriptRoot
}

# Resolve persistent data dir.
$dataDir = $env:CLAUDE_PLUGIN_DATA
if ([string]::IsNullOrEmpty($dataDir)) {
    $localAppData = $env:LOCALAPPDATA
    if ([string]::IsNullOrEmpty($localAppData)) {
        $localAppData = Join-Path $env:USERPROFILE 'AppData\Local'
    }
    $dataDir = Join-Path $localAppData 'agent-harness'
}
if (-not (Test-Path -LiteralPath $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
}

# Find a free TCP port in 4400..4500 by attempting to bind.
function Test-PortFree {
    param([int]$Port)
    $listener = $null
    try {
        $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($null -ne $listener) {
            try { $listener.Stop() } catch {}
        }
    }
}

$chosenPort = 0
for ($p = 4400; $p -le 4500; $p++) {
    if (Test-PortFree -Port $p) {
        $chosenPort = $p
        break
    }
}
if ($chosenPort -eq 0) {
    Write-Error "No free TCP port found in 4400-4500."
    exit 1
}

# Locate the dashboard server entry.
$serverEntry = Join-Path $pluginRoot 'apps/dashboard-server/dist/server.js'
if (-not (Test-Path -LiteralPath $serverEntry)) {
    Write-Host "Dashboard server not built. Run ``pnpm install && pnpm build`` first." -ForegroundColor Yellow
    exit 1
}

# Spawn node detached, capture PID.
$envBlock = @{
    HARNESS_PORT     = "$chosenPort"
    HARNESS_DATA_DIR = "$dataDir"
}
foreach ($k in $envBlock.Keys) {
    Set-Item -Path "Env:$k" -Value $envBlock[$k]
}

# -NoNewWindow keeps the child in the parent console group so its lifecycle
# tracks the launching shell; it conflicts with -WindowStyle, so we drop the
# latter (the dashboard process has no GUI surface anyway).
$proc = Start-Process -FilePath 'node' `
    -ArgumentList @("`"$serverEntry`"") `
    -NoNewWindow `
    -PassThru

# Persist state for the dashboard command and future re-launches.
$state = [ordered]@{
    port      = $chosenPort
    pid       = $proc.Id
    startedAt = (Get-Date).ToString('o')
}
$statePath = Join-Path $dataDir 'state.json'
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8

$url = "http://127.0.0.1:$chosenPort"
Write-Host "Dashboard: $url"

# Open default browser.
Start-Process $url | Out-Null
