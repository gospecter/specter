/**
 * Tests for src/license/machineid.ts.
 *
 * Each platform module is tested in isolation by mocking the fs and
 * child_process modules. We reset modules between tests so mocks don't leak.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.resetModules());

// ── darwin ─────────────────────────────────────────────────────────────────

describe('getMachineId – darwin', () => {
  it('parses IOPlatformUUID from ioreg output', async () => {
    const fakeUuid = 'AABBCCDD-1122-3344-5566-778899AABBCC';
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn().mockReturnValue(
        `"IOPlatformUUID" = "${fakeUuid}"\n`,
      ),
    }));
    vi.doMock('node:fs', () => ({ readFileSync: vi.fn() }));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');

    const { getMachineId } = await import('../src/license/machineid.js');
    expect(getMachineId()).toBe(fakeUuid);
  });

  it('throws when ioreg output has no UUID', async () => {
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn().mockReturnValue('no uuid here\n'),
    }));
    vi.doMock('node:fs', () => ({ readFileSync: vi.fn() }));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');

    const { getMachineId } = await import('../src/license/machineid.js');
    expect(() => getMachineId()).toThrow(/unable to determine machine id/i);
  });
});

// ── win32 ──────────────────────────────────────────────────────────────────

describe('getMachineId – win32', () => {
  it('returns wmic UUID when wmic is available', async () => {
    const fakeUuid = '11223344-AABB-CCDD-EEFF-001122334455';
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn()
        .mockImplementationOnce((_cmd: string) => `UUID\r\n${fakeUuid}\r\n`)
        // powershell should not be called
        .mockImplementation(() => { throw new Error('unexpected call'); }),
    }));
    vi.doMock('node:fs', () => ({ readFileSync: vi.fn() }));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const { getMachineId } = await import('../src/license/machineid.js');
    expect(getMachineId()).toBe(fakeUuid);
  });

  it('falls back to PowerShell when wmic throws', async () => {
    const fakeUuid = 'FFEEDDCC-BBAA-9988-7766-554433221100';
    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn()
        .mockImplementationOnce(() => { throw new Error('wmic not found'); })
        .mockImplementationOnce(() => `${fakeUuid}\r\n`),
    }));
    vi.doMock('node:fs', () => ({ readFileSync: vi.fn() }));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');

    const { getMachineId } = await import('../src/license/machineid.js');
    expect(getMachineId()).toBe(fakeUuid);
  });
});

// ── linux ──────────────────────────────────────────────────────────────────

describe('getMachineId – linux', () => {
  it('reads /sys/class/dmi/id/product_uuid when available', async () => {
    const fakeUuid = 'deadbeef-dead-beef-dead-beefdeadbeef';
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn() }));
    vi.doMock('node:fs', () => ({
      readFileSync: vi.fn().mockReturnValue(`${fakeUuid}\n`),
    }));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    const { getMachineId } = await import('../src/license/machineid.js');
    expect(getMachineId()).toBe(fakeUuid);
  });

  it('falls back to /etc/machine-id when dmi uuid is not accessible', async () => {
    const machineId = 'abcdef1234567890abcdef1234567890';
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn() }));
    vi.doMock('node:fs', () => ({
      readFileSync: vi.fn()
        .mockImplementationOnce(() => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        })
        .mockImplementationOnce(() => `${machineId}\n`),
    }));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    const { getMachineId } = await import('../src/license/machineid.js');
    expect(getMachineId()).toBe(machineId);
  });

  it('throws when neither source is readable', async () => {
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn() }));
    vi.doMock('node:fs', () => ({
      readFileSync: vi.fn().mockImplementation(() => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }),
    }));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    const { getMachineId } = await import('../src/license/machineid.js');
    expect(() => getMachineId()).toThrow(/unable to determine machine id/i);
  });
});

// ── unsupported platform ───────────────────────────────────────────────────

describe('getMachineId – unsupported platform', () => {
  it('throws on an unknown OS', async () => {
    vi.doMock('node:child_process', () => ({ execFileSync: vi.fn() }));
    vi.doMock('node:fs', () => ({ readFileSync: vi.fn() }));
    vi.spyOn(process, 'platform', 'get').mockReturnValue('aix' as NodeJS.Platform);

    const { getMachineId } = await import('../src/license/machineid.js');
    expect(() => getMachineId()).toThrow(/unable to determine machine id/i);
  });
});
