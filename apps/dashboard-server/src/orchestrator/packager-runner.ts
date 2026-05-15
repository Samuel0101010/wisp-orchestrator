/**
 * packager-runner — Phase 7 (v1.15) native-packaging runner.
 *
 * Runs a single packager task synchronously: probes Tauri CLI + Rust toolchain,
 * scaffolds `src-tauri/` if missing, builds the web bundle (`pnpm build`),
 * runs `pnpm tauri build`, locates the installer in the bundle output dir,
 * computes size + sha256, copies it under `<dataDir>/artifacts/<projectId>/<runId>/`
 * and writes a deterministic `docs/build-manifest.json` next to the repo.
 *
 * The `execImpl` argument is a test seam — production callers leave it
 * undefined and the runner uses the real `execa`. Tests inject a mock that
 * doesn't shell out, so unit tests never invoke `cargo` or `tauri`.
 *
 * V1 trade-offs (deliberate):
 *  - Synchronous: the caller awaits the full pipeline. POST /build can take
 *    minutes; that's fine for v1 — no background worker.
 *  - sha256 is read with `fs.readFileSync`. Up to ~500MB installers this is
 *    OK on a workstation; for true streaming we'd refactor later.
 *  - Only `tauri-exe` is implemented. Other `packageTarget` values short-
 *    circuit with an error.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../env.js';

// Subset of execa's options we use here — keeps the test seam tiny and
// avoids leaking the execa type surface across the codebase.
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type ExecImpl = (
  file: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string | undefined>; reject?: boolean },
) => Promise<ExecResult>;

export type PackagerError =
  | 'tauri_cli_missing'
  | 'rust_toolchain_missing'
  | 'web_build_failed'
  | 'tauri_build_failed'
  | 'artifact_not_found'
  | 'unsupported_target';

export interface PackagerResult {
  ok: boolean;
  artifactPath: string | null;
  relativeBuildPath: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  error?: PackagerError;
  buildLog: string;
  durationMs: number;
}

export interface RunPackagerArgs {
  projectId: string;
  runId: string;
  repoPath: string;
  packageTarget: 'web' | 'tauri-exe' | 'electron-exe' | 'pkg-bin';
  /** Display name used for the Tauri window title — falls back to projectId. */
  appName?: string;
  /** Test seam — production callers omit this and use the real execa. */
  execImpl?: ExecImpl;
  /** Test seam — override the data-dir root used for the artifact copy. */
  dataDirOverride?: string;
}

const TAIL_BYTES = 4_000;

function tail(s: string): string {
  if (!s) return '';
  return s.length <= TAIL_BYTES ? s : s.slice(s.length - TAIL_BYTES);
}

async function defaultExec(
  file: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string | undefined>; reject?: boolean },
): Promise<ExecResult> {
  const { execa } = await import('execa');
  try {
    const r = await execa(file, args, {
      cwd: opts?.cwd,
      env: opts?.env as Record<string, string> | undefined,
      reject: opts?.reject ?? false,
    });
    return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } catch (err) {
    const e = err as { exitCode?: number; stdout?: string; stderr?: string; message?: string };
    return {
      exitCode: typeof e.exitCode === 'number' ? e.exitCode : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? '',
    };
  }
}

/**
 * Walk `dir` (recursively) and return the first file whose basename matches
 * one of the patterns. Patterns are checked with `endsWith` after lower-
 * casing so we can match `.msi`, `.exe`, `.dmg`, etc. cross-platform.
 */
function findFirstByExt(dir: string, exts: string[]): string | null {
  if (!fs.existsSync(dir)) return null;
  const lowerExts = exts.map((e) => e.toLowerCase());
  const stack: string[] = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    // Sort for determinism — readdir order is FS-dependent.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        const lower = ent.name.toLowerCase();
        if (lowerExts.some((ext) => lower.endsWith(ext))) {
          return full;
        }
      }
    }
  }
  return null;
}

const TAURI_INSTALLER_EXTS = [
  '.msi',
  '.exe', // Windows installers (NSIS produces .exe)
  '.dmg',
  '.app.tar.gz',
  '.appimage',
  '.deb',
  '.rpm',
];

/**
 * Run the packager. Returns a `PackagerResult` — `ok=false` for every
 * foreseen failure (missing CLI, missing toolchain, build failure, no
 * installer produced). The route layer maps `ok=false` to HTTP 422.
 */
export async function runPackager(args: RunPackagerArgs): Promise<PackagerResult> {
  const started = Date.now();
  const exec = args.execImpl ?? defaultExec;
  const buildLogParts: string[] = [];
  const appendLog = (label: string, r: ExecResult): void => {
    buildLogParts.push(`# ${label}\n[exit=${r.exitCode}]\n${tail(r.stdout)}\n${tail(r.stderr)}\n`);
  };

  const fail = (error: PackagerError): PackagerResult => ({
    ok: false,
    artifactPath: null,
    relativeBuildPath: null,
    sizeBytes: null,
    sha256: null,
    error,
    buildLog: tail(buildLogParts.join('\n')),
    durationMs: Date.now() - started,
  });

  if (args.packageTarget !== 'tauri-exe') {
    return fail('unsupported_target');
  }

  // (a) Probe Tauri CLI.
  const tauriProbe = await exec('pnpm', ['exec', 'tauri', '--version'], { cwd: args.repoPath });
  appendLog('tauri --version', tauriProbe);
  if (tauriProbe.exitCode !== 0) {
    return fail('tauri_cli_missing');
  }

  // (b) Probe Rust toolchain.
  const cargoProbe = await exec('cargo', ['--version'], { cwd: args.repoPath });
  appendLog('cargo --version', cargoProbe);
  if (cargoProbe.exitCode !== 0) {
    return fail('rust_toolchain_missing');
  }

  // (c) Scaffold src-tauri if missing.
  const srcTauriDir = path.join(args.repoPath, 'src-tauri');
  if (!fs.existsSync(srcTauriDir)) {
    const name = args.appName ?? args.projectId;
    const init = await exec(
      'pnpm',
      [
        'exec',
        'tauri',
        'init',
        '--ci',
        '--app-name',
        name,
        '--window-title',
        name,
        '--frontend-dist',
        '../dist',
        '--dev-url',
        'http://127.0.0.1:5173',
      ],
      { cwd: args.repoPath },
    );
    appendLog('tauri init', init);
    // Don't hard-fail on init exit code — `tauri init` can return non-zero on
    // existing configs even when scaffolding completed. We re-check existence.
    if (!fs.existsSync(srcTauriDir)) {
      return fail('tauri_build_failed');
    }
  }

  // (d) Web build.
  const web = await exec('pnpm', ['build'], { cwd: args.repoPath });
  appendLog('pnpm build', web);
  if (web.exitCode !== 0) {
    return fail('web_build_failed');
  }

  // (e) Tauri build.
  const tauri = await exec('pnpm', ['exec', 'tauri', 'build'], { cwd: args.repoPath });
  appendLog('pnpm tauri build', tauri);
  if (tauri.exitCode !== 0) {
    return fail('tauri_build_failed');
  }

  // (f) Locate the installer. Tauri puts bundles under
  // `src-tauri/target/release/bundle/<kind>/*`. We sweep the whole bundle dir
  // for the first known installer extension.
  const bundleDir = path.join(args.repoPath, 'src-tauri', 'target', 'release', 'bundle');
  const installer = findFirstByExt(bundleDir, TAURI_INSTALLER_EXTS);
  if (!installer) {
    return fail('artifact_not_found');
  }

  // (g) Compute size + sha256.
  const stat = fs.statSync(installer);
  const sizeBytes = stat.size;
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex');

  // (h) Copy to <dataDir>/artifacts/<projectId>/<runId>/<basename>.
  const dataDir = args.dataDirOverride ?? env.HARNESS_DATA_DIR;
  const destDir = path.join(dataDir, 'artifacts', args.projectId, args.runId);
  fs.mkdirSync(destDir, { recursive: true });
  const basename = path.basename(installer);
  const destPath = path.join(destDir, basename);
  // Overwrite-safe — fs.copyFileSync replaces existing destination.
  fs.copyFileSync(installer, destPath);

  // (i) Write docs/build-manifest.json deterministically.
  const manifest = {
    target: args.packageTarget,
    artifactPath: destPath,
    sizeBytes,
    sha256,
    builtAt: new Date().toISOString(),
  };
  const docsDir = path.join(args.repoPath, 'docs');
  try {
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(
      path.join(docsDir, 'build-manifest.json'),
      JSON.stringify(manifest, null, 2) + '\n',
      'utf8',
    );
  } catch {
    // Manifest write is best-effort — the artifact + sha256 already live in
    // the API response and on disk in the data dir.
  }

  return {
    ok: true,
    artifactPath: destPath,
    relativeBuildPath: path.relative(args.repoPath, installer),
    sizeBytes,
    sha256,
    buildLog: tail(buildLogParts.join('\n')),
    durationMs: Date.now() - started,
  };
}
