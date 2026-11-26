import { Component, inject, signal } from '@angular/core';
import { t } from '../core/i18n';
import { MidiService } from '../platform/midi.service';

/**
 * The browser's page with this site's permissions (Brave, Edge, Vivaldi or Chrome/Chromium and the others). There,
 * "MIDI devices: Allow" works even when the browser blocked it by itself (that block isn't in the MIDI list).
 * Web pages can't open these addresses: the player copies it into a tab.
 */
function siteSettingsUrl(): string {
  const scheme = (navigator as Navigator & { brave?: unknown }).brave ? 'brave'
    : /\bEdg\//.test(navigator.userAgent) ? 'edge'
    : /\bVivaldi\//.test(navigator.userAgent) ? 'vivaldi' : 'chrome';
  return `${scheme}://settings/content/siteDetails?site=${encodeURIComponent(location.origin)}`;
}

/**
 * Notice shown while the browser hasn't allowed MIDI (the drum kit) for the game — not answered, closed or
 * blocked — with a button that asks again. It disappears by itself as soon as MIDI is allowed.
 */
@Component({
  selector: 'app-midi-permission',
  template: `
    @if (midi.permission(); as p) {
      @if (p === 'prompt' || p === 'denied') {
        <div class="midi-perm" [class.denied]="p === 'denied'" role="alert">
          <div>
            <b>{{ p === 'denied' ? t('midi.blockedTitle') : t('midi.askTitle') }}</b>
            <p>{{ p === 'denied' ? t('midi.blockedText') : t('midi.askText') }}</p>
            @if (p === 'denied') {
              <div class="addr"><code>{{ settingsUrl }}</code>
                <button class="secondary" (click)="copy()">{{ copied() ? t('midi.copied') : t('midi.copyButton') }}</button></div>
            }
          </div>
          <button class="primary" (click)="midi.requestAccess()">{{ p === 'denied' ? t('midi.retryButton') : t('midi.askButton') }}</button>
        </div>
      }
    }
  `,
  styles: [`
    .midi-perm { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin: 10px 0; padding: 12px 14px;
      border-radius: 10px; border: 1px solid #a8741a; background: #281c06; color: #ffd58a; font-size: 13px; line-height: 1.45; }
    .midi-perm > div { flex: 1 1 260px; }
    .midi-perm b { font-size: 14px; }
    .midi-perm p { margin: 4px 0 0; color: #f3dcae; overflow-wrap: anywhere; }
    .midi-perm.denied { border-color: #b8404f; background: #2a0d12; color: #ffb3bf; }
    .midi-perm.denied p { color: #f1c9d0; }
    .midi-perm button { flex: 0 0 auto; }
    .addr { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .addr code { padding: 6px 8px; border-radius: 6px; background: rgb(0 0 0 / 0.35); color: #fff; font-size: 12px;
      user-select: all; overflow-wrap: anywhere; }
    .addr button { padding: 6px 10px; font-size: 12px; }
  `],
})
export class MidiPermissionComponent {
  readonly midi = inject(MidiService);
  readonly t = t;
  readonly settingsUrl = siteSettingsUrl();
  readonly copied = signal(false);

  async copy(): Promise<void> {
    try { await navigator.clipboard.writeText(this.settingsUrl); }
    catch {   // no clipboard permission: select the text so Ctrl+C works
      const code = document.querySelector('.midi-perm .addr code');
      if (code) getSelection()?.selectAllChildren(code);
    }
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 2000);
  }
}
