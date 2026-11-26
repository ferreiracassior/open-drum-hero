import { Injectable, signal } from '@angular/core';
import { t } from '../core/i18n';
import { Observable, Subject, share } from 'rxjs';
import { nativePlugins, platformKind } from './platform';

/** A hit from the drum kit, already on this device's clock (performance.now). */
export interface MidiHit { note: number; velocity: number; time: number; }

export interface MidiStatus { connected: boolean; ports: string[]; error?: string; }

/**
 * Drum kit name as shown to the player. Android names USB devices "manufacturer + product", and many products
 * already start with the brand ("NUX" + "NUX DM-200 Series" = "NUX NUX DM-200 Series"): the repeated word goes.
 */
export function portName(name: string): string {
  const words = name.trim().split(/\s+/);
  while (words.length > 1 && words[0].toLowerCase() === words[1].toLowerCase()) words.splice(1, 1);
  return words.join(' ');
}

/**
 * Ports that are not a device: Linux (ALSA) always creates "Midi Through Port-0", which only echoes what other
 * programs send to it. They are left out of the list, so "no drum kit" shows when nothing is plugged in.
 */
export function isVirtualPort(name: string): boolean {
  return /^midi through\b/i.test(name.trim());
}

/**
 * Electronic drum kit plugged straight into the device (USB), with no PC in between:
 * - exe/browser: Web MIDI (Windows sees the drum kit as a standard USB MIDI device).
 * - apk: native plugin with Android's MIDI API (USB OTG).
 * Any "class compliant" USB MIDI drum kit works; piece mapping lives in Map drum kit.
 */
@Injectable({ providedIn: 'root' })
export class MidiService {
  readonly status = signal<MidiStatus>({ connected: false, ports: [] });
  private readonly subject = new Subject<MidiHit>();
  readonly hits$: Observable<MidiHit> = this.subject.pipe(share());

  constructor() {
    if (platformKind() === 'android') void this.startAndroid();
    else void this.startWebMidi();
  }

  private handle(status: number, d1: number, d2: number, time: number): void {
    if ((status & 0xf0) === 0x90 && d2 > 0) this.subject.next({ note: d1, velocity: d2, time });
  }

  private async startWebMidi(): Promise<void> {
    if (!navigator.requestMIDIAccess) {
      this.status.set({ connected: false, ports: [], error: t('err.noWebMidi') });
      return;
    }
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false });
      const bind = () => {
        const ports: string[] = [];
        access.inputs.forEach(input => {
          if (isVirtualPort(input.name ?? '')) { input.onmidimessage = null; return; }
          ports.push(portName(input.name ?? 'MIDI'));
          input.onmidimessage = (e: MIDIMessageEvent) => {
            const d = e.data;
            if (d && d.length >= 3) this.handle(d[0], d[1], d[2], e.timeStamp || performance.now());
          };
        });
        this.status.set({ connected: ports.length > 0, ports });
      };
      access.onstatechange = bind;
      bind();
    } catch (e) {
      this.status.set({ connected: false, ports: [], error: t('err.midiPermission', { msg: (e as Error).message }) });
    }
  }

  private async startAndroid(): Promise<void> {
    const plugin = nativePlugins().DrumHero;
    if (!plugin) {
      this.status.set({ connected: false, ports: [], error: t('err.noMidiPlugin') });
      return;
    }
    // the plugin sends the event age (now - instant of the hit), to convert it to the local clock
    await plugin.addListener('midi', e => this.handle(e.status, e.data1, e.data2, performance.now() - Math.max(0, e.ageMs)));
    await plugin.addListener('midiStatus', e => this.status.set({ connected: e.ports.length > 0, ports: e.ports.map(portName) }));
    try {
      const r = await plugin.startMidi();
      this.status.set({ connected: r.ports.length > 0, ports: r.ports.map(portName) });
    } catch (e) {
      this.status.set({ connected: false, ports: [], error: (e as Error).message });
    }
  }
}
