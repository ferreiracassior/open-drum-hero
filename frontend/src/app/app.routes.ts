import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./pages/home.component').then(m => m.HomeComponent), title: 'OpenDrumHero' },
  { path: 'play/:id', loadComponent: () => import('./pages/game.component').then(m => m.GameComponent), title: 'OpenDrumHero' },
  { path: 'settings', loadComponent: () => import('./pages/settings.component').then(m => m.SettingsComponent), title: 'OpenDrumHero' },
  { path: 'kit', loadComponent: () => import('./pages/kit.component').then(m => m.KitComponent), title: 'OpenDrumHero' },
  { path: 'share', loadComponent: () => import('./pages/share.component').then(m => m.ShareComponent) },
  { path: '**', redirectTo: '' },
];
