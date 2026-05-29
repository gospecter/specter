/**
 * Tests for the cross-platform install dispatcher.
 *
 * Rather than patching process.platform (which has reliability issues across
 * vitest versions), we import each platform module directly and test the
 * business logic by mocking the child_process and fs modules they use.
 *
 * The dispatcher (index.ts) is tested separately by spying on process.platform.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// ── dispatcher (index.ts) ──────────────────────────────────────────────────

describe('install dispatcher', () => {
  afterEach(() => vi.resetModules());

  it('throws on unsupported platform', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('freebsd' as NodeJS.Platform);
    const { install } = await import('../src/cli/install/index.js');
    await expect(install()).rejects.toThrow(/unsupported platform/i);
  });
});

// ── darwin module ──────────────────────────────────────────────────────────

describe('install/darwin – uninstall', () => {
  afterEach(() => vi.resetModules());

  it('reports "not installed" when the plist is missing', async () => {
    vi.doMock('node:fs', () => ({
      promises: {
        unlink: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
        access: vi.fn().mockRejectedValue(new Error()),
      },
    }));
    vi.doMock('node:child_process', () => ({
      spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('../../src/config.js', () => ({
      logPath: () => '/tmp/ghost-sync.log',
      loadConfig: vi.fn().mockResolvedValue({}),
      requireConfig: vi.fn().mockReturnValue({}),
    }));

    const { uninstall } = await import('../src/cli/install/darwin.js');
    const result = await uninstall();
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/not installed/i);
  });
});

// ── linux module ──────────────────────────────────────────────────────────

describe('install/linux – uninstall', () => {
  afterEach(() => vi.resetModules());

  it('succeeds even when the unit file does not exist', async () => {
    vi.doMock('node:fs', () => ({
      existsSync: vi.fn().mockReturnValue(false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      promises: {
        unlink: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
      },
    }));
    vi.doMock('node:child_process', () => ({
      spawnSync: vi.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' }),
    }));
    vi.doMock('../../src/config.js', () => ({
      logPath: () => '/tmp/ghost-sync.log',
      loadConfig: vi.fn().mockResolvedValue({}),
      requireConfig: vi.fn().mockReturnValue({}),
    }));

    const { uninstall } = await import('../src/cli/install/linux.js');
    const result = await uninstall();
    expect(result.ok).toBe(true);
  });
});

// ── win32 module ──────────────────────────────────────────────────────────

describe('install/win32 – uninstall', () => {
  afterEach(() => vi.resetModules());

  it('succeeds when the task does not exist (schtasks error contains "cannot find")', async () => {
    vi.doMock('node:child_process', () => ({
      spawnSync: vi.fn().mockReturnValue({
        status: 1,
        stdout: 'ERROR: The system cannot find the file specified.',
        stderr: '',
      }),
    }));
    vi.doMock('node:fs', () => ({
      mkdirSync: vi.fn(),
    }));
    vi.doMock('../../src/config.js', () => ({
      logPath: () => 'C:\\logs\\ghost-sync.log',
      loadConfig: vi.fn().mockResolvedValue({}),
      requireConfig: vi.fn().mockReturnValue({}),
    }));

    const { uninstall } = await import('../src/cli/install/win32.js');
    const result = await uninstall();
    expect(result.ok).toBe(true);
  });
});
