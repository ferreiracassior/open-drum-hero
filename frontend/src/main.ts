import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app';
import { appConfig } from './app/app.config';
import { setupDesktopBrowser } from './app/platform/desktop-browser';

// In the exe, the game opens in the PC's browser: first of all, set up the bridge with the exe and bring the
// settings and the library from its files. Outside the exe this does nothing.
setupDesktopBrowser()
  .catch(e => console.warn('bridge with the exe', e))
  .finally(() => bootstrapApplication(App, appConfig).catch(err => console.error(err)));

// PWA: required to install on Android and show up in the "Share" menu.
if ('serviceWorker' in navigator && location.port !== '4200') {
  navigator.serviceWorker.register('/sw.js').catch(e => console.warn('service worker', e));
}
