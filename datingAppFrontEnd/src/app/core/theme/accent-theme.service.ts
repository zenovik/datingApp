import { Injectable, signal } from '@angular/core';

const STORAGE_KEY = 'datingapp_accent';

export interface AccentPalette {
  id: string;
  label: string;
  accent: string;
  accentStrong: string;
  accentRgb: string;
  /* Second stop for decorative brand gradients (primary CTAs, hero icons) -
     paired with `accent` for a two-tone gradient rather than a flat fill. */
  accentWarm: string;
  accentWarmRgb: string;
}

/* Bold, saturated Tailwind-style hues (not muted/pastel) - modeled on
   heartlink.co.in's shipped palette: a vivid primary that shifts to a warm
   second tone in gradients, matching LoveFox's playful, energetic brand.
   Red stays the default/first entry per product decision - it's the
   brand's original color and what every fresh visitor sees. */
const PALETTES: AccentPalette[] = [
  { id: 'red', label: 'Red', accent: '#e11d2e', accentStrong: '#a1121f', accentRgb: '225, 29, 46', accentWarm: '#ff8a5b', accentWarmRgb: '255, 138, 91' },
  { id: 'pink', label: 'Pink', accent: '#ec4899', accentStrong: '#db2777', accentRgb: '236, 72, 153', accentWarm: '#ff8a5b', accentWarmRgb: '255, 138, 91' },
  { id: 'purple', label: 'Purple', accent: '#a855f7', accentStrong: '#7e22ce', accentRgb: '168, 85, 247', accentWarm: '#ec4899', accentWarmRgb: '236, 72, 153' },
  { id: 'blue', label: 'Blue', accent: '#3b82f6', accentStrong: '#1d4ed8', accentRgb: '59, 130, 246', accentWarm: '#a855f7', accentWarmRgb: '168, 85, 247' },
  { id: 'teal', label: 'Teal', accent: '#14b8a6', accentStrong: '#0f766e', accentRgb: '20, 184, 166', accentWarm: '#22c55e', accentWarmRgb: '34, 197, 94' },
  { id: 'orange', label: 'Orange', accent: '#f97316', accentStrong: '#c2410c', accentRgb: '249, 115, 22', accentWarm: '#f59e0b', accentWarmRgb: '245, 158, 11' },
  { id: 'green', label: 'Green', accent: '#22c55e', accentStrong: '#15803d', accentRgb: '34, 197, 94', accentWarm: '#14b8a6', accentWarmRgb: '20, 184, 166' },
];

const DEFAULT_PALETTE_ID = PALETTES[0].id;

@Injectable({ providedIn: 'root' })
export class AccentThemeService {
  readonly palettes = PALETTES;
  readonly accentId = signal(this.readStoredAccent());

  constructor() {
    // Applied here (not just from a component) so the accent color is set as
    // early as possible - mirrors ThemeService, which does the same for
    // dark/light mode.
    this.apply(this.accentId());
  }

  set(accentId: string): void {
    this.accentId.set(accentId);
    this.apply(accentId);
    localStorage.setItem(STORAGE_KEY, accentId);
  }

  private apply(accentId: string): void {
    const palette = this.palettes.find((p) => p.id === accentId) ?? this.palettes[0];
    const root = document.documentElement.style;
    root.setProperty('--accent', palette.accent);
    root.setProperty('--accent-strong', palette.accentStrong);
    root.setProperty('--accent-rgb', palette.accentRgb);
    root.setProperty('--accent-warm', palette.accentWarm);
    root.setProperty('--accent-warm-rgb', palette.accentWarmRgb);

    // Keeps the mobile browser chrome/PWA title bar color in sync too -
    // index.html's <meta name="theme-color"> is a static tag the OS reads
    // outside of CSS, so it needs its own update rather than a CSS variable.
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', palette.accent);
  }

  private readStoredAccent(): string {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored && PALETTES.some((p) => p.id === stored) ? stored : DEFAULT_PALETTE_ID;
  }
}
