import { describe, expect, it } from 'vitest';
import { isVirtualPort, portName } from './midi.service';

describe('portName', () => {
  it('drops the brand Android repeats in front of the product', () => {
    expect(portName('NUX NUX DM-200 Series')).toBe('NUX DM-200 Series');
    expect(portName('Roland roland TD-17')).toBe('Roland TD-17');
  });

  it('keeps names without a repeated word', () => {
    expect(portName('NUX DM-200 Series')).toBe('NUX DM-200 Series');
    expect(portName('Alesis Nitro Max')).toBe('Alesis Nitro Max');
    expect(portName('MIDI')).toBe('MIDI');
  });
});

describe('isVirtualPort', () => {
  it('leaves out the Linux "Midi Through" port', () => {
    expect(isVirtualPort('Midi Through Port-0')).toBe(true);
    expect(isVirtualPort('Midi Through:Midi Through Port-0 14:0')).toBe(true);
  });

  it('keeps real drum kits', () => {
    expect(isVirtualPort('NUX DM-200 Series')).toBe(false);
    expect(isVirtualPort('Alesis Nitro Max MIDI 1')).toBe(false);
  });
});
