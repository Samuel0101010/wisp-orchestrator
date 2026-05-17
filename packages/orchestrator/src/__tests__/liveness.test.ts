import { describe, it, expect } from 'vitest';
import process from 'node:process';
import {
  parsePosixCpuTime,
  parseWindowsCpuTime,
  isPidAlive,
  probePidLiveness,
} from '../liveness.js';

describe('liveness — parsePosixCpuTime', () => {
  it('parses m:ss.cs (mm-ss with fractional)', () => {
    expect(parsePosixCpuTime('0:01.23')).toBeCloseTo(1.23);
  });
  it('parses h:mm:ss', () => {
    expect(parsePosixCpuTime('1:23:45')).toBe(1 * 3600 + 23 * 60 + 45);
  });
  it('parses mm:ss', () => {
    expect(parsePosixCpuTime('01:23')).toBe(83);
  });
  it('parses d-hh:mm:ss BSD form', () => {
    expect(parsePosixCpuTime('2-00:00:01')).toBe(2 * 86400 + 1);
  });
  it('returns null on garbage', () => {
    expect(parsePosixCpuTime('')).toBeNull();
    expect(parsePosixCpuTime('not-a-time')).toBeNull();
    expect(parsePosixCpuTime('1:2:3:4')).toBeNull();
  });
});

describe('liveness — parseWindowsCpuTime', () => {
  it('parses a decimal seconds value', () => {
    expect(parseWindowsCpuTime('12.34375')).toBeCloseTo(12.34375);
  });
  it('parses an integer', () => {
    expect(parseWindowsCpuTime('7')).toBe(7);
  });
  it('returns null on negative or NaN', () => {
    expect(parseWindowsCpuTime('-1')).toBeNull();
    expect(parseWindowsCpuTime('abc')).toBeNull();
    expect(parseWindowsCpuTime('')).toBeNull();
  });
});

describe('liveness — isPidAlive', () => {
  it('returns true for the current process', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
  it('returns false for a definitely-gone pid', () => {
    // Use a pid that has effectively zero chance of being alive on any host.
    // Using a very large value rather than 0/1 avoids hitting EPERM on the
    // init process on Linux.
    expect(isPidAlive(2 ** 31 - 2)).toBe(false);
  });
});

describe('liveness — probePidLiveness', () => {
  it('returns alive=true for the current process and a numeric CPU reading or null', () => {
    const probe = probePidLiveness(process.pid);
    expect(probe.alive).toBe(true);
    // CPU reading may fail in sandboxed CI; we only assert the shape.
    expect(probe.cpuSeconds === null || typeof probe.cpuSeconds === 'number').toBe(true);
  });
  it('returns alive=false for a gone pid', () => {
    const probe = probePidLiveness(2 ** 31 - 2);
    expect(probe.alive).toBe(false);
    expect(probe.cpuSeconds).toBeNull();
  });
});
