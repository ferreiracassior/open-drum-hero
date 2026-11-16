import { Component, inject } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { nativePlugins, platformKind } from './platform/platform';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: '<router-outlet />',
})
export class App {
  constructor() {
    // phone (apk): only the library can be used upright; the game and the other screens stay landscape
    if (platformKind() !== 'android') return;
    inject(Router).events.subscribe(e => {
      if (!(e instanceof NavigationEnd)) return;
      const path = e.urlAfterRedirects.split(/[?#]/)[0];
      void nativePlugins().DrumHero?.setOrientation?.({ mode: path === '/' ? 'any' : 'landscape' })?.catch(() => {});
    });
  }
}
