/**
 * Tests for the cross-platform notify module.
 *
 * We test each platform branch in isolation by importing the module-under-test
 * and mocking `child_process.spawnSync` to verify the right tool is invoked and
 * that the return value is mapped correctly.
 *
 * `process.platform` is not reliably stubbable via vi.spyOn in all vitest
 * versions, so the platform-specific helper functions are tested directly by
 * temporarily swapping out spawnSync behaviour rather than patching the
 * platform getter.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// ── helpers ────────────────────────────────────────────────────────────────

type SpawnSyncFn = typeof import('node:child_process').spawnSync;

/** Build a spawnSync stub that returns a fixed exit code and stdout. */
function stubSpawnSync(status: number, stdout = ''): SpawnSyncFn {
  return vi.fn().mockReturnValue({ status, stdout, stderr: '', error: undefined }) as unknown as SpawnSyncFn;
}

/** Build a spawnSync stub that simulates ENOENT (command not found). */
function stubSpawnSyncMissing(): SpawnSyncFn {
  return vi.fn().mockReturnValue({
    status: null,
    stdout: '',
    stderr: '',
    error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
  }) as unknown as SpawnSyncFn;
}

// ── darwin ─────────────────────────────────────────────────────────────────

describe('promptConflict – darwin', () => {
  afterEach(() => vi.resetModules());

  it('returns keep_local when osascript output contains "Keep Local"', async () => {
    vi.doMock('node:child_process', () => ({
      spawnSync: stubSpawnSync(0, 'button returned:Keep Local\n'),
      spawn: vi.fn(),
    }));
    vi.doMock('node-notifier', () => ({ default: { notify: vi.fn() } }));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');

    const { promptConflict } = await import('../src/notify.js');
    expect(promptConflict('test')).toBe('keep_local');
  });

  it('returns keep_remote when osascript output contains "Keep Ghost"', async () => {
    vi.doMock('node:child_process', () => ({
      spawnSync: stubSpawnSync(0, 'button returned:Keep Ghost\n'),
      spawn: vi.fn(),
    }));
    vi.doMock('node-notifier', () => ({ default: { notify: vi.fn() } }));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');

    const { promptConflict } = await import('../src/notify.js');
    expect(promptConflict('test')).toBe('keep_remote');
  });

  it('returns skip when osascript exits non-zero', async () => {
    vi.doMock('node:child_process', () => ({
      spawnSync: stubSpawnSync(1, ''),
      spawn: vi.fn(),
    }));
    vi.doMock('node-notifier', () => ({ default: { notify: vi.fn() } }));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');

    const { promptConflict } = await import('../src/notify.js');
    expect(promptConflict('test')).toBe('skip');
  });
});

// ── win32 ──────────────────────────────────────────────────────────────────

describe('promptConflict – win32', () => {
  afterEach(() => vi.resetModules());

  it('returns keep_local when PowerShell prints "Yes"', async () => {
    vi.doMock('node:child_process', () => ({
      spawnSync: stubSpawnSync(0, 'Yes\n'),
      spawn: vi.fn(),
    }));
    vi.doMock('node-notifier', () => ({ default: { notify: vi.fn() } }));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const { promptConflict } = await import('../src/notify.js');
    expect(promptConflict('test')).toBe('keep_local');
  });

  it('returns keep_remote when PowerShell prints "No"', async () => {
    vi.doMock('node:child_process', () => ({
      spawnSync: stubSpawnSync(0, 'No\n'),
      spawn: vi.fn(),
    }));
    vi.doMock('node-notifier', () => ({ default: { notify: vi.fn() } }));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const { promptConflict } = await import('../src/notify.js');
    expect(promptConflict('test')).toBe('keep_remote');
  });

  it('returns skip when PowerShell prints "Cancel"', async () => {
    vi.doMock('node:child_process', () => ({
      spawnSync: stubSpawnSync(0, 'Cancel\n'),
      spawn: vi.fn(),
    }));
    vi.doMock('node-notifier', () => ({ default: { notify: vi.fn() } }));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const { promptConflict } = await import('../src/notify.js');
    expect(promptConflict('test')).toBe('skip');
  });

  it('passes conflict titles through base64 instead of interpolating PowerShell code', async () => {
    const spawnSyncMock = stubSpawnSync(0, 'Cancel\n');
    vi.doMock('node:child_process', () => ({
      spawnSync: spawnSyncMock,
      spawn: vi.fn(),
    }));
    vi.doMock('node-notifier', () => ({ default: { notify: vi.fn() } }));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const { promptConflict } = await import('../src/notify.js');
    promptConflict('$(Start-Process calc.exe)');

    const [, args] = vi.mocked(spawnSyncMock).mock.calls[0];
    const command = (args as string[])[2];
    expect(command).not.toContain('Start-Process');
    expect(command).toContain('FromBase64String');
  });
});

// ── linux ──────────────────────────────────────────────────────────────────

describe('promptConflict – linux', () => {
  afterEach(() => vi.resetModules());

  it('returns keep_local when zenity exits 0', async () => {
    vi.doMock('node:child_process', () => ({
      spawnSync: stubSpawnSync(0, ''),
      spawn: vi.fn(),
    }));
    vi.doMock('node-notifier', () => ({ default: { notify: vi.fn() } }));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    const { promptConflict } = await import('../src/notify.js');
    expect(promptConflict('test')).toBe('keep_local');
  });

  it('returns keep_remote when zenity stdout is "Keep Ghost"', async () => {
    vi.doMock('node:child_process', () => ({
      spawnSync: stubSpawnSync(1, 'Keep Ghost'),
      spawn: vi.fn(),
    }));
    vi.doMock('node-notifier', () => ({ default: { notify: vi.fn() } }));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    const { promptConflict } = await import('../src/notify.js');
    expect(promptConflict('test')).toBe('keep_remote');
  });

  it('falls back to kdialog when zenity is missing', async () => {
    let callCount = 0;
    const spawnSyncMock = vi.fn().mockImplementation((..._args: unknown[]) => {
      callCount++;
      if (callCount === 1) {
        // First call: zenity — simulate ENOENT
        return {
          status: null,
          stdout: '',
          stderr: '',
          error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
        };
      }
      // Second call: kdialog — simulate "Keep Local" (exit 0)
      return { status: 0, stdout: '', stderr: '', error: undefined };
    });

    vi.doMock('node:child_process', () => ({
      spawnSync: spawnSyncMock,
      spawn: vi.fn(),
    }));
    vi.doMock('node-notifier', () => ({ default: { notify: vi.fn() } }));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    const { promptConflict } = await import('../src/notify.js');
    expect(promptConflict('test')).toBe('keep_local');
    expect(callCount).toBe(2);
  });

  it('returns skip and writes to stderr when neither zenity nor kdialog is available', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.doMock('node:child_process', () => ({
      spawnSync: stubSpawnSyncMissing(),
      spawn: vi.fn(),
    }));
    vi.doMock('node-notifier', () => ({ default: { notify: vi.fn() } }));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    const { promptConflict } = await import('../src/notify.js');
    expect(promptConflict('test')).toBe('skip');
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('WARNING'));
    stderrSpy.mockRestore();
  });
});
