import { signal } from '@angular/core';

/** Whether the game fills the whole screen: through the browser API (click on the notice) or the browser's F11. */
const check = () =>
  !!document.fullscreenElement ||
  matchMedia('(display-mode: fullscreen)').matches ||
  (innerWidth >= screen.width && innerHeight >= screen.height);

export const isFullscreen = signal(check());
const update = () => isFullscreen.set(check());
addEventListener('resize', update);
document.addEventListener('fullscreenchange', update);

export function enterFullscreen(): void {
  void document.documentElement.requestFullscreen?.().catch(() => {});
}

/** Leaves the fullscreen the game requested. (The browser's F11 one only exits with F11.) */
export function exitFullscreen(): void {
  if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
}

/** Fullscreen through the browser's F11 (the page can't leave it by itself). */
export const isBrowserF11 = () => isFullscreen() && !document.fullscreenElement;
