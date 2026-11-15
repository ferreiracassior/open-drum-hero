import { describe, expect, it } from 'vitest';
import { DeviceSettings, mergeDevices } from './settings.service';

const dev = (audioOffsetMs: number): DeviceSettings => ({
  audioOffsetMs, hitWindowMs: 117, chordWindowMs: 50, earlyWindowMs: 50, scrollSpeed: 1, quality: 'low', antialias: 'off',
});

describe('mergeDevices', () => {
  it('cópia local antiga sem data não sobrescreve o servidor', () => {
    const r = mergeDevices({ devices: { mobile: dev(60) } }, { devices: { mobile: dev(120) } });
    expect(r.devices.mobile?.audioOffsetMs).toBe(120);
  });

  it('servidor mais novo vence a cópia local', () => {
    const r = mergeDevices(
      { devices: { mobile: dev(90) }, devicesUpdatedAt: { mobile: 1000 } },
      { devices: { mobile: dev(120) }, devicesUpdatedAt: { mobile: 2000 } });
    expect(r.devices.mobile?.audioOffsetMs).toBe(120);
  });

  it('mudança local mais nova (ainda não salva no servidor) é mantida', () => {
    const r = mergeDevices(
      { devices: { mobile: dev(130) }, devicesUpdatedAt: { mobile: 3000 } },
      { devices: { mobile: dev(120) }, devicesUpdatedAt: { mobile: 2000 } });
    expect(r.devices.mobile?.audioOffsetMs).toBe(130);
  });

  it('aparelho que só existe no servidor entra', () => {
    const r = mergeDevices({ devices: {} }, { devices: { pc: dev(30) } });
    expect(r.devices.pc?.audioOffsetMs).toBe(30);
  });
});
