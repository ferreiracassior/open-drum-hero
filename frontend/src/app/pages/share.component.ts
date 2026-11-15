import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { t } from '../core/i18n';
import { SongService, extractSongsterrUrl } from '../core/song.service';

/** Target of Android's "Share" (Web Share Target: /share?title=&text=&url=). */
@Component({
  selector: 'app-share',
  imports: [RouterLink],
  template: `
    <main class="page">
      @if (url()) {
        <p>{{ t('share.importing') }} <code>{{ url() }}</code>…</p>
      } @else {
        <p class="err">{{ t('share.noLink') }}</p>
        <pre>{{ raw() }}</pre>
        <a routerLink="/">{{ t('common.back') }}</a>
      }
    </main>
  `,
  styleUrl: './pages.scss',
})
export class ShareComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private songs = inject(SongService);
  readonly t = t;
  readonly url = signal<string | null>(null);
  readonly raw = signal('');

  ngOnInit(): void {
    const q = this.route.snapshot.queryParamMap;
    const parts = [q.get('url'), q.get('text'), q.get('title')];
    this.raw.set(parts.filter(Boolean).join('\n'));
    const url = extractSongsterrUrl(...parts);
    this.url.set(url);
    if (url) {
      this.songs.ingest(url);
      void this.router.navigate(['/'], { replaceUrl: true });
    }
  }
}
