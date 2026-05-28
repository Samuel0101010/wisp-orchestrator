# WISP dashboard launcher (Windows)
# Idempotent: re-running picks a free port and writes a fresh state.json.
# requires-exec: PowerShell execution; invoke via -ExecutionPolicy Bypass.

$ErrorActionPreference = 'Stop'

# Node version preflight — fail fast with a clear message instead of
# burning 60+ seconds in pnpm install only to crash with a cryptic
# SyntaxError or ABI mismatch on the actual server start.
try {
    $rawNodeVer = (& node --version 2>$null).TrimStart('v')
    $minNodeVer = [version]'20.10'
    if ([version]$rawNodeVer -lt $minNodeVer) {
        Write-Error "Node >= 20.10 required (found v$rawNodeVer). Install the latest LTS from https://nodejs.org and re-run /wisp-dashboard."
        exit 1
    }
} catch {
    Write-Error "Could not detect Node.js. Install Node 20.10+ from https://nodejs.org and re-run /wisp-dashboard."
    exit 1
}

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
    # Resolve a pnpm invocation. Prefer a directly installed pnpm; otherwise
    # fall back to corepack (shipped with Node >=16.13), which honours the
    # packageManager pin in package.json and needs no global install.
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    $corepack = Get-Command corepack -ErrorAction SilentlyContinue
    $pnpmExe = $null
    $pnpmArgsPrefix = @()
    if ($null -ne $pnpm) {
        $pnpmExe = 'pnpm'
    } elseif ($null -ne $corepack) {
        Write-Host "  pnpm not found; using corepack (Node-bundled) instead." -ForegroundColor Cyan
        # Activate the pinned pnpm version so corepack doesn't prompt
        # interactively on Node >=22 (the prompt hangs Claude Code's Bash tool
        # which has no stdin). The version must match package.json#packageManager.
        & corepack prepare 'pnpm@10.33.2' --activate
        if ($LASTEXITCODE -ne 0) {
            Write-Error "corepack prepare pnpm@10.33.2 failed — install pnpm globally with 'npm install -g pnpm' and retry."
            exit 1
        }
        $pnpmExe = 'corepack'
        $pnpmArgsPrefix = @('pnpm')
    } else {
        Write-Error "Neither 'pnpm' nor 'corepack' is on PATH. Install Node 20+ (corepack ships with it) or run: npm install -g pnpm"
        exit 1
    }
    Push-Location $pluginRoot
    try {
        Write-Host "  $pnpmExe install..." -ForegroundColor Cyan
        & $pnpmExe @pnpmArgsPrefix install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { Write-Error "pnpm install failed."; exit 1 }
        Write-Host "  $pnpmExe build..." -ForegroundColor Cyan
        & $pnpmExe @pnpmArgsPrefix build
        if ($LASTEXITCODE -ne 0) { Write-Error "pnpm build failed."; exit 1 }
    } finally {
        Pop-Location
    }
    if (-not (Test-Path -LiteralPath $serverEntry)) {
        Write-Error "Bootstrap finished but $serverEntry still missing."
        exit 1
    }
    $webIndex = Join-Path $pluginRoot 'apps/dashboard-web/dist/index.html'
    if (-not (Test-Path -LiteralPath $webIndex)) {
        Write-Error "Bootstrap finished but $webIndex is missing — the web bundle did not build. Re-run 'pnpm -r build' from $pluginRoot to see the underlying error."
        exit 1
    }
    Write-Host "  Built. Starting dashboard..." -ForegroundColor Green
}

# Spawn node detached, capture PID.
$envBlock = @{
    WISP_PORT      = "$chosenPort"
    WISP_DATA_DIR  = "$dataDir"
    WISP_SERVE_WEB = '1'
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

# Detachment + stdio redirection: PowerShell's Start-Process can't do both
# (-WindowStyle Hidden silently drops the redirect parameters in PS5.x).
# Delegate to a tiny node helper that uses child_process.spawn with
# `detached: true` + file descriptors for stdio. The helper prints the
# child's PID and exits; the dashboard survives the launching console
# closing because it's been promoted out of our process group.
$spawnHelper = Join-Path $PSScriptRoot 'wisp-spawn-detached.cjs'
$spawnArgs = @($spawnHelper, $serverEntry, $logOut, $logErr)
$pidOutput = & node @spawnArgs 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Error "wisp-spawn-detached.cjs failed: $pidOutput"
    exit 1
}
$dashboardPid = [int]($pidOutput -split "`n" | Where-Object { $_ -match '^\d+$' } | Select-Object -First 1)
if (-not $dashboardPid) {
    Write-Error "wisp-spawn-detached.cjs did not print a PID: $pidOutput"
    exit 1
}
# Shape-compatible proxy object so the rest of the script (state.json etc.)
# can keep referencing $proc.Id without conditionals.
$proc = [PSCustomObject]@{ Id = $dashboardPid }

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

# Wait until the server has bound the port before opening the browser,
# otherwise the user sees a connection-refused page and has to refresh.
# Probe at 200ms intervals up to 6 seconds (covers cold-start migrations +
# Fastify init on a slow first boot).
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 200
    try {
        $probe = New-Object System.Net.Sockets.TcpClient
        $probe.Connect('127.0.0.1', $chosenPort)
        $probe.Close()
        $ready = $true
        break
    } catch {
        # not ready yet
    }
}
if (-not $ready) {
    Write-Host "Dashboard not responding on $url after 6 seconds. Check $logErr." -ForegroundColor Yellow
}

# Open default browser.
Start-Process $url | Out-Null
