import './setup.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runPackager,
  bundleIdentifier,
  type ExecImpl,
  type ExecResult,
} from '../orchestrator/packager-runner.js';

interface MockedCall {
  file: string;
  args: string[];
}

interface MockResponses {
  [key: string]: ExecResult | ((args: string[], cwd?: string) => Promise<ExecResult> | ExecResult);
}

function makeExecImpl(responses: MockResponses, capture: MockedCall[] = []): ExecImpl {
  return async (file, args, opts) => {
    capture.push({ file, args });
    const key = `${file} ${args.join(' ')}`;
    for (const pattern of Object.keys(responses)) {
      if (key.startsWith(pattern)) {
        const r = responses[pattern];
        const val = typeof r === 'function' ? await r(args, opts?.cwd) : r;
        return val;
      }
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

const tempDirs: string[] = [];

function mkTemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // Windows occasionally holds handles on freshly-written files.
    }
  }
});

describe('packager-runner', () => {
  it('returns tauri_cli_missing when `tauri --version` fails', async () => {
    const repoPath = mkTemp('pkg-test-');
    const dataDir = mkTemp('pkg-data-');
    const execImpl = makeExecImpl({
      'pnpm exec tauri --version': { exitCode: 1, stdout: '', stderr: 'command not found' },
    });
    const r = await runPackager({
      projectId: 'p1',
      runId: 'r1',
      repoPath,
      packageTarget: 'tauri-exe',
      execImpl,
      dataDirOverride: dataDir,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('tauri_cli_missing');
    expect(r.artifactPath).toBeNull();
  });

  it('returns rust_toolchain_missing when cargo is absent', async () => {
    const repoPath = mkTemp('pkg-test-');
    const dataDir = mkTemp('pkg-data-');
    const execImpl = makeExecImpl({
      'pnpm exec tauri --version': { exitCode: 0, stdout: 'tauri 1.5.0', stderr: '' },
      'cargo --version': { exitCode: 127, stdout: '', stderr: 'cargo: not found' },
    });
    const r = await runPackager({
      projectId: 'p1',
      runId: 'r1',
      repoPath,
      packageTarget: 'tauri-exe',
      execImpl,
      dataDirOverride: dataDir,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('rust_toolchain_missing');
  });

  it('returns web_build_failed when pnpm build exits non-zero', async () => {
    const repoPath = mkTemp('pkg-test-');
    fs.mkdirSync(path.join(repoPath, 'src-tauri'), { recursive: true });
    const dataDir = mkTemp('pkg-data-');
    const execImpl = makeExecImpl({
      'pnpm exec tauri --version': { exitCode: 0, stdout: 'tauri 1.5.0', stderr: '' },
      'cargo --version': { exitCode: 0, stdout: 'cargo 1.78.0', stderr: '' },
      'pnpm build': { exitCode: 1, stdout: '', stderr: 'vite build error' },
    });
    const r = await runPackager({
      projectId: 'p1',
      runId: 'r1',
      repoPath,
      packageTarget: 'tauri-exe',
      execImpl,
      dataDirOverride: dataDir,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('web_build_failed');
    expect(r.buildLog).toContain('vite build error');
  });

  it('returns unsupported_target for non-tauri-exe targets', async () => {
    const repoPath = mkTemp('pkg-test-');
    const dataDir = mkTemp('pkg-data-');
    const r = await runPackager({
      projectId: 'p1',
      runId: 'r1',
      repoPath,
      packageTarget: 'electron-exe',
      execImpl: makeExecImpl({}),
      dataDirOverride: dataDir,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('unsupported_target');
  });

  it('happy path: copies installer to data-dir and returns sha256 + size', async () => {
    const repoPath = mkTemp('pkg-test-');
    fs.mkdirSync(path.join(repoPath, 'src-tauri'), { recursive: true });
    const dataDir = mkTemp('pkg-data-');

    // The mock for `pnpm tauri build` creates a fake installer in the
    // expected bundle directory; the runner will find it via the recursive
    // bundle scan.
    const bundleDir = path.join(repoPath, 'src-tauri', 'target', 'release', 'bundle', 'msi');
    const execImpl = makeExecImpl({
      'pnpm exec tauri --version': { exitCode: 0, stdout: 'tauri 1.5.0', stderr: '' },
      'cargo --version': { exitCode: 0, stdout: 'cargo 1.78.0', stderr: '' },
      'pnpm build': { exitCode: 0, stdout: 'build ok', stderr: '' },
      'pnpm exec tauri build': () => {
        fs.mkdirSync(bundleDir, { recursive: true });
        fs.writeFileSync(path.join(bundleDir, 'demo_0.1.0_x64_en-US.msi'), 'FAKE_INSTALLER_BYTES');
        return { exitCode: 0, stdout: 'bundled', stderr: '' };
      },
    });

    const r = await runPackager({
      projectId: 'proj-1',
      runId: 'run-1',
      repoPath,
      packageTarget: 'tauri-exe',
      execImpl,
      dataDirOverride: dataDir,
    });
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.artifactPath).not.toBeNull();
    expect(r.sizeBytes).toBeGreaterThan(0);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.relativeBuildPath).toContain('demo_0.1.0_x64_en-US.msi');
    // Artifact must exist at the expected dataDir location.
    expect(fs.existsSync(r.artifactPath!)).toBe(true);
    expect(r.artifactPath).toBe(
      path.join(dataDir, 'artifacts', 'proj-1', 'run-1', 'demo_0.1.0_x64_en-US.msi'),
    );
    // Manifest must have landed in docs/.
    const manifestPath = path.join(repoPath, 'docs', 'build-manifest.json');
    expect(fs.existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(manifest.sha256).toBe(r.sha256);
    expect(manifest.target).toBe('tauri-exe');
  });

  it('returns artifact_not_found when tauri build succeeds but no installer is produced', async () => {
    const repoPath = mkTemp('pkg-test-');
    fs.mkdirSync(path.join(repoPath, 'src-tauri'), { recursive: true });
    const dataDir = mkTemp('pkg-data-');
    const execImpl = makeExecImpl({
      'pnpm exec tauri --version': { exitCode: 0, stdout: 'tauri 1.5.0', stderr: '' },
      'cargo --version': { exitCode: 0, stdout: 'cargo 1.78.0', stderr: '' },
      'pnpm build': { exitCode: 0, stdout: '', stderr: '' },
      'pnpm exec tauri build': { exitCode: 0, stdout: '', stderr: '' },
    });
    const r = await runPackager({
      projectId: 'p1',
      runId: 'r1',
      repoPath,
      packageTarget: 'tauri-exe',
      execImpl,
      dataDirOverride: dataDir,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('artifact_not_found');
  });

  it('re-run replaces the artifact under the same destination path', async () => {
    const repoPath = mkTemp('pkg-test-');
    fs.mkdirSync(path.join(repoPath, 'src-tauri'), { recursive: true });
    const dataDir = mkTemp('pkg-data-');
    const bundleDir = path.join(repoPath, 'src-tauri', 'target', 'release', 'bundle', 'msi');
    let contents = 'V1';

    const baseResponses: MockResponses = {
      'pnpm exec tauri --version': { exitCode: 0, stdout: 'tauri 1.5.0', stderr: '' },
      'cargo --version': { exitCode: 0, stdout: 'cargo 1.78.0', stderr: '' },
      'pnpm build': { exitCode: 0, stdout: '', stderr: '' },
      'pnpm exec tauri build': () => {
        fs.mkdirSync(bundleDir, { recursive: true });
        fs.writeFileSync(path.join(bundleDir, 'demo.msi'), contents);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    };

    const first = await runPackager({
      projectId: 'p',
      runId: 'r',
      repoPath,
      packageTarget: 'tauri-exe',
      execImpl: makeExecImpl(baseResponses),
      dataDirOverride: dataDir,
    });
    expect(first.ok).toBe(true);
    const firstSha = first.sha256;
    contents = 'V2_DIFFERENT';

    const second = await runPackager({
      projectId: 'p',
      runId: 'r',
      repoPath,
      packageTarget: 'tauri-exe',
      execImpl: makeExecImpl(baseResponses),
      dataDirOverride: dataDir,
    });
    expect(second.ok).toBe(true);
    expect(second.sha256).not.toBe(firstSha);
    expect(second.artifactPath).toBe(first.artifactPath);
    expect(fs.readFileSync(second.artifactPath!, 'utf8')).toBe('V2_DIFFERENT');
  });

  it('scaffolds with a unique --identifier, never the default com.tauri.dev', async () => {
    // No src-tauri on disk -> the runner must scaffold via `tauri init`. A real
    // forced build proved `tauri init` without --identifier keeps com.tauri.dev,
    // which `tauri build` rejects ("must be unique"), so the build always failed.
    const repoPath = mkTemp('pkg-test-');
    const dataDir = mkTemp('pkg-data-');
    const srcTauriDir = path.join(repoPath, 'src-tauri');
    const bundleDir = path.join(srcTauriDir, 'target', 'release', 'bundle', 'nsis');
    const capture: MockedCall[] = [];
    const execImpl = makeExecImpl(
      {
        'pnpm exec tauri --version': { exitCode: 0, stdout: 'tauri-cli 2.11.2', stderr: '' },
        'cargo --version': { exitCode: 0, stdout: 'cargo 1.95.0', stderr: '' },
        'pnpm exec tauri init': () => {
          fs.mkdirSync(srcTauriDir, { recursive: true }); // real init writes the scaffold
          return { exitCode: 0, stdout: '', stderr: '' };
        },
        'pnpm build': { exitCode: 0, stdout: '', stderr: '' },
        'pnpm exec tauri build': () => {
          fs.mkdirSync(bundleDir, { recursive: true });
          fs.writeFileSync(path.join(bundleDir, 'app_0.1.0_x64-setup.exe'), 'INSTALLER');
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
      capture,
    );

    const r = await runPackager({
      projectId: '66c414a0-4570-46e9-9a0c-95875b9e9f93',
      runId: 'run-1',
      repoPath,
      packageTarget: 'tauri-exe',
      appName: 'Pomodoro Focus Timer',
      execImpl,
      dataDirOverride: dataDir,
    });
    expect(r.ok).toBe(true);

    const initCall = capture.find((c) => c.args.includes('init'));
    expect(initCall).toBeDefined();
    const idx = initCall!.args.indexOf('--identifier');
    expect(idx).toBeGreaterThan(-1);
    const identifier = initCall!.args[idx + 1];
    expect(identifier).not.toBe('com.tauri.dev');
    expect(identifier).toBe('com.wisp.pomodoro-focus-timer-66c414a0');
  });

  it('bundleIdentifier is unique, valid, and never the default', () => {
    expect(bundleIdentifier('Pomodoro Focus Timer', '66c414a0-4570-46e9')).toBe(
      'com.wisp.pomodoro-focus-timer-66c414a0',
    );
    // A digit/symbol-leading name still yields a valid letter-led identifier.
    const weird = bundleIdentifier('123 app!!', 'abcd1234-ef');
    expect(weird).not.toBe('com.tauri.dev');
    expect(weird).toMatch(/^com\.wisp\.[a-z][a-z0-9-]*$/);
    // Two projects with the same name still get distinct identifiers.
    expect(bundleIdentifier('Same', 'aaaa1111-x')).not.toBe(bundleIdentifier('Same', 'bbbb2222-y'));
  });
});
