// Minimal service worker: makes the app installable (PWA + Share).
// Network always first; the game depends on the PC over the cable anyway.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* let the browser fetch normally */ });
