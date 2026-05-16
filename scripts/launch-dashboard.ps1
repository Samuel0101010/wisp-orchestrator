# WISP dashboard launcher (Windows)
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

# Locate the dashboard server entry. Auto-bootstrap on first launch.
$serverEntry = Join-Path $pluginRoot 'apps/dashboard-server/dist/server.js'
if (-not (Test-Path -LiteralPath $serverEntry)) {
    Write-Host "First launch: building WISP (~1-2 minutes)..." -ForegroundColor Cyan
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($null -eq $pnpm) {
        Write-Error "pnpm not found on PATH. Install it first: npm install -g pnpm"
        exit 1
    }
    Push-Location $pluginRoot
    try {
        Write-Host "  pnpm install..." -ForegroundColor Cyan
        & pnpm install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { Write-Error "pnpm install failed."; exit 1 }
        Write-Host "  pnpm build..." -ForegroundColor Cyan
        & pnpm build
        if ($LASTEXITCODE -ne 0) { Write-Error "pnpm build failed."; exit 1 }
    } finally {
        Pop-Location
    }
    if (-not (Test-Path -LiteralPath $serverEntry)) {
        Write-Error "Bootstrap finished but $serverEntry still missing."
        exit 1
    }
    Write-Host "  Built. Starting dashboard..." -ForegroundColor Green
}

# Spawn node detached, capture PID.
$envBlock = @{
    HARNESS_PORT      = "$chosenPort"
    HARNESS_DATA_DIR  = "$dataDir"
    HARNESS_SERVE_WEB = '1'
}
foreach ($k in $envBlock.Keys) {
    Set-Item -Path "Env:$k" -Value $envBlock[$k]
}

# Redirect stdio to per-stream log files in dataDir. Mirrors the bash
# launcher (nohup ... >server.log 2>&1) so a Windows install also has a
# discoverable log when something goes wrong. PowerShell's Start-Process
# can't merge stdout+stderr to one file, so we emit two.
$logOut = Join-Path $dataDir 'server.log'
$logErr = Join-Path $dataDir 'server.err.log'

# -NoNewWindow keeps the child in the parent console group so its lifecycle
# tracks the launching shell; it conflicts with -WindowStyle, so we drop the
# latter (the dashboard process has no GUI surface anyway).
$proc = Start-Process -FilePath 'node' `
    -ArgumentList @("`"$serverEntry`"") `
    -NoNewWindow `
    -PassThru `
    -RedirectStandardOutput $logOut `
    -RedirectStandardError $logErr

# Persist state for the dashboard command and future re-launches.
$state = [ordered]@{
    port      = $chosenPort
    pid       = $proc.Id
    startedAt = (Get-Date).ToString('o')
    logOut    = $logOut
    logErr    = $logErr
}
$statePath = Join-Path $dataDir 'state.json'
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding utf8

$url = "http://127.0.0.1:$chosenPort"
Write-Host "Dashboard: $url"
Write-Host "Logs: $logOut (stderr: $logErr)"

# Open default browser.
Start-Process $url | Out-Null
