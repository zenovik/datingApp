import { AfterViewInit, Directive, ElementRef, Input, OnDestroy, inject } from '@angular/core';

/**
 * Adds `.is-revealed` to the host once it scrolls into view, so plain CSS
 * (see the `.reveal` rules in styles.css) can transition it in - a fade +
 * rise, the same move used for scroll-triggered sections on sites like
 * ochi.design, just toned down for a product UI instead of a portfolio.
 *
 * Usage: `<div class="reveal" appReveal>...</div>` - optionally
 * `[appReveal]="i"` (an *ngFor index) to stagger a group via a CSS
 * transition-delay, so cards in a row animate in one after another instead
 * of all at once.
 *
 * Pure IntersectionObserver, no animation library - fires once per element
 * (unobserves itself after revealing) and does nothing if the browser lacks
 * IntersectionObserver or the user has requested reduced motion, in which
 * case the element's default (visible) CSS state is what shows.
 */
@Directive({
  selector: '[appReveal]',
  standalone: true,
  host: { class: 'reveal' },
})
export class RevealOnScrollDirective implements AfterViewInit, OnDestroy {
  // Bare `appReveal` (no binding) comes through as the empty string, not a
  // number - accept both so the directive works either plain or with
  // `[appReveal]="i"` for a staggered group.
  @Input('appReveal') staggerIndex: number | string | null = null;

  private readonly el = inject(ElementRef<HTMLElement>);
  private observer?: IntersectionObserver;

  ngAfterViewInit(): void {
    const node = this.el.nativeElement;

    const index = Number(this.staggerIndex);
    if (this.staggerIndex !== null && this.staggerIndex !== '' && !Number.isNaN(index)) {
      node.style.transitionDelay = `${Math.min(index, 8) * 90}ms`;
    }

    if (
      typeof IntersectionObserver === 'undefined' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      node.classList.add('is-revealed');
      return;
    }

    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            node.classList.add('is-revealed');
            this.observer?.unobserve(node);
          }
        }
      },
      { threshold: 0.15, rootMargin: '0px 0px -8% 0px' },
    );
    this.observer.observe(node);
  }

  ngOnDestroy(): void {
    this.observer?.disconnect();
  }
}
