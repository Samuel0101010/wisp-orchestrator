# WISP dashboard launcher (Windows)
# Idempotent: a re-run reuses a live server if one is recorded in state.json;
# otherwise it picks a free port and writes a fresh state.json.
# requires-exec: PowerShell execution; invoke via -ExecutionPolicy Bypass.

$ErrorActionPreference = 'Stop'

# Node version preflight — fail fast with a clear message instead of
# burning 60+ seconds in pnpm install only to crash with a cryptic
# SyntaxError or ABI mismatch on the actual server start.
try {
    # Normalise the version string before the [version] cast: strip a leading
    # 'v' and any prerelease/build suffix (e.g. '22.0.0-nightly'), otherwise a
    # valid-but-tagged Node would throw on the cast and be misreported as "not
    # detected".
    $rawNodeVer = ((& node --version) 2>$null).TrimStart('v') -replace '[-+].*$', ''
    $minNodeVer = [version]'20.10'
    if ([version]$rawNodeVer -lt $minNodeVer) {
        Write-Host "Node >= 20.10 required (found v$rawNodeVer). Install Node 22 LTS or Node 24 LTS from https://nodejs.org and re-run /wisp-dashboard." -ForegroundColor Red
        exit 1
    }
    # Soft upper bound: the pinned better-sqlite3 (12.9.0) ships prebuilt binaries
    # through Node 25. A newer Node forces a source compile (needs a C++ toolchain),
    # so warn — but do NOT block, since a machine WITH build tools is fine. Bump
    # this ceiling whenever the better-sqlite3 pin is upgraded.
    $nodeMajor = [int]($rawNodeVer.Split('.')[0])
    if ($nodeMajor -gt 25) {
        Write-Host "Note: Node v$rawNodeVer is newer than the tested range; if install fails on better-sqlite3, install Node 24 LTS (a prebuilt binary exists for it - no compiler needed)." -ForegroundColor Yellow
    }
} catch {
    Write-Host "Could not detect Node.js. Install Node 22 LTS or Node 24 LTS from https://nodejs.org and re-run /wisp-dashboard." -ForegroundColor Red
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
$statePath = Join-Path $dataDir 'state.json'

# Idempotency: if a previous launch's server is still alive AND its port is still
# bound, reuse it instead of spawning a second server (which would orphan the
# first and put two writers on the same SQLite DB).
if (Test-Path -LiteralPath $statePath) {
    try {
        $prev = Get-Content -LiteralPath $statePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
        if ($prev.pid -and $prev.port) {
            $alive = $null -ne (Get-Process -Id ([int]$prev.pid) -ErrorAction SilentlyContinue)
            if ($alive) {
                $bound = $false
                try {
                    $probe = New-Object System.Net.Sockets.TcpClient
                    $probe.Connect('127.0.0.1', [int]$prev.port)
                    $probe.Close()
                    $bound = $true
                } catch {
                    $bound = $false
                }
                if ($bound) {
                    $reuseUrl = "http://127.0.0.1:$($prev.port)"
                    Write-Host "Dashboard already running (pid $($prev.pid)): $reuseUrl"
                    Start-Process $reuseUrl | Out-Null
                    exit 0
                }
            }
        }
    } catch {
        # stale/corrupt state.json — ignore and spawn fresh
    }
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
    Write-Host "No free TCP port found in 4400-4500." -ForegroundColor Red
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
        # Activate the pinned pnpm version so corepack doesn't prompt interactively
        # on Node >=22 (the prompt hangs Claude Code's Bash tool which has no stdin).
        # corepack bundled with older Node (< 0.31) can't verify pnpm 10's signature
        # ("Cannot find matching keyid"); on failure, fall back to a version-pinned
        # global pnpm via npm (always present with Node, no signing-key dependency).
        & corepack prepare 'pnpm@10.33.2' --activate
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  corepack could not prepare pnpm@10.33.2 (bundled corepack may be too old to verify its signature)." -ForegroundColor Yellow
            Write-Host "  Falling back to: npm install -g pnpm@10.33.2" -ForegroundColor Yellow
            & npm install -g pnpm@10.33.2
            $pnpmAvail = Get-Command pnpm -ErrorAction SilentlyContinue
            if ($LASTEXITCODE -ne 0 -or $null -eq $pnpmAvail) {
                Write-Host "Could not obtain pnpm@10.33.2 via corepack or npm. Install it manually (npm install -g pnpm@10.33.2) and re-run /wisp-dashboard." -ForegroundColor Red
                exit 1
            }
            $pnpmExe = 'pnpm'
            $pnpmArgsPrefix = @()
        } else {
            $pnpmExe = 'corepack'
            $pnpmArgsPrefix = @('pnpm')
        }
    } else {
        Write-Host "Neither 'pnpm' nor 'corepack' is on PATH. Install Node 22 LTS (corepack ships with it) or run: npm install -g pnpm@10.33.2" -ForegroundColor Red
        exit 1
    }
    Push-Location $pluginRoot
    try {
        # Tee install/build output to a log so a native-build failure (better-sqlite3
        # node-gyp on a toolchain-less box) is recoverable instead of lost to
        # scrollback. EAP=Continue around the native pipeline: in PS 5.1, `2>&1`
        # on a native exe wraps stderr lines as ErrorRecords which would throw
        # under EAP=Stop and abort mid-install.
        $installLog = Join-Path $dataDir 'install.log'
        Write-Host "  $pnpmExe install... (log: $installLog)" -ForegroundColor Cyan
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & $pnpmExe @pnpmArgsPrefix install --frozen-lockfile 2>&1 | Tee-Object -FilePath $installLog
        $installExit = $LASTEXITCODE
        $ErrorActionPreference = $prevEAP
        if ($installExit -ne 0) {
            Write-Host ""
            Write-Host "pnpm install failed (exit $installExit). Full log: $installLog" -ForegroundColor Red
            $gyp = Select-String -Path $installLog -Pattern 'node-gyp|prebuild-install|gyp ERR|MSBuild|Visual Studio' -Quiet -ErrorAction SilentlyContinue
            if ($gyp) {
                Write-Host "Cause: the native module better-sqlite3 had no prebuilt binary for your Node (v$rawNodeVer) and tried to compile from source." -ForegroundColor Yellow
                Write-Host "Easiest fix: install Node 24 LTS (or Node 22 LTS) from https://nodejs.org - a prebuilt binary exists, no compiler needed - then re-run /wisp-dashboard." -ForegroundColor Yellow
                Write-Host "Or install Visual Studio Build Tools with the 'Desktop development with C++' workload." -ForegroundColor Yellow
            }
            exit 1
        }
        $buildLog = Join-Path $dataDir 'build.log'
        Write-Host "  $pnpmExe build... (log: $buildLog)" -ForegroundColor Cyan
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        & $pnpmExe @pnpmArgsPrefix build 2>&1 | Tee-Object -FilePath $buildLog
        $buildExit = $LASTEXITCODE
        $ErrorActionPreference = $prevEAP
        if ($buildExit -ne 0) {
            Write-Host ""
            Write-Host "pnpm build failed (exit $buildExit). Full log: $buildLog" -ForegroundColor Red
            exit 1
        }
    } finally {
        Pop-Location
    }
    if (-not (Test-Path -LiteralPath $serverEntry)) {
        Write-Host "Bootstrap finished but $serverEntry still missing." -ForegroundColor Red
        exit 1
    }
    $webIndex = Join-Path $pluginRoot 'apps/dashboard-web/dist/index.html'
    if (-not (Test-Path -LiteralPath $webIndex)) {
        Write-Host "Bootstrap finished but $webIndex is missing - the web bundle did not build. Re-run 'pnpm -r build' from $pluginRoot to see the underlying error." -ForegroundColor Red
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
    Write-Host "wisp-spawn-detached.cjs failed: $pidOutput" -ForegroundColor Red
    exit 1
}
$dashboardPid = [int]($pidOutput -split "`n" | Where-Object { $_ -match '^\d+$' } | Select-Object -First 1)
if (-not $dashboardPid) {
    Write-Host "wisp-spawn-detached.cjs did not print a PID: $pidOutput" -ForegroundColor Red
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
    Write-Host "Dashboard not responding on $url after 6 seconds. Last log lines:" -ForegroundColor Yellow
    if (Test-Path -LiteralPath $logErr) {
        Get-Content -LiteralPath $logErr -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" }
    }
    if (Test-Path -LiteralPath $logOut) {
        Get-Content -LiteralPath $logOut -Tail 15 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  $_" }
    }
}

# Open default browser.
Start-Process $url | Out-Null
