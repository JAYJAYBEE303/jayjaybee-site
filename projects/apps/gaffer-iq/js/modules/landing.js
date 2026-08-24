/**
 * js/modules/landing.js
 * Layer: module (owns the DOM). No analytical logic, no network.
 * Renders the landing route at /projects/apps/gaffer-iq/ — the front page a
 * visitor lands on before entering any module.
 *
 * Almost entirely presentational: the markup lives in index.html and the
 * styling in components.css. This file owns three things:
 *   1. the `is-landing` body class that hides the app chrome (see layout.css),
 *   2. the scroll-reveal system that fades each block in,
 *   3. one live value — the gameweek named in the eyebrow pill.
 *
 * Store subscriptions:
 *   route:changed — toggles the body class and, on first entry, runs the reveal.
 *   data:ready    — fills in the real gameweek number.
 */

import { store } from '../store.js';

const MODULE_KEY = 'landing';

/** Stagger between elements in one reveal batch, and the cap on that stagger. */
const REVEAL_STEP_MS = 70;
const REVEAL_MAX_DELAY_MS = 360;

/**
 * Safety net. If the observer never fires — a browser quirk, a display:none
 * ancestor at the wrong moment, an extension interfering — every element is
 * force-revealed at this point. A landing page that stays blank is a far worse
 * failure than one that skips its animation, so this is deliberately short.
 */
const REVEAL_FALLBACK_MS = 900;

/** Matches the observer used across the page; see initReveal(). */
const OBSERVER_OPTIONS = { rootMargin: '0px 0px -8% 0px', threshold: 0.06 };

let root = null;
let hasRevealed = false;

/**
 * Reveal one element after `index` steps of stagger.
 * @param {HTMLElement} el
 * @param {number} index   position within the batch, 0-based
 */
function revealElement(el, index) {
  const delay = Math.min(index * REVEAL_STEP_MS, REVEAL_MAX_DELAY_MS);
  el.style.setProperty('--reveal-delay', `${delay}ms`);
  // Next frame, so the browser has painted the pre-transition state at least
  // once. Adding the class in the same frame the element becomes visible makes
  // it jump straight to the end state with no transition.
  requestAnimationFrame(() => el.classList.add('is-visible'));
}

/** Top-to-bottom, so a batch reveals in reading order rather than DOM order. */
function sortByTop(a, b) {
  return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
}

/**
 * Wire the scroll-reveal system. Runs once, the first time the landing route is
 * actually on screen — the elements have to be laid out for the above-the-fold
 * measurement below to mean anything, and a `display: none` section measures as
 * a zero-height box at the top of the viewport (CONVENTIONS.md §8).
 */
function initReveal() {
  const els = Array.from(root.querySelectorAll('.landing-reveal'));
  if (!els.length) return;

  const prefersReduced = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // No observer, or the visitor has asked for less motion: show everything at
  // once. The CSS already flattens .landing-reveal under the same media query,
  // so this is belt-and-braces rather than the only path.
  if (prefersReduced || !('IntersectionObserver' in window)) {
    els.forEach(el => el.classList.add('is-visible'));
    return;
  }

  const observer = new IntersectionObserver((entries) => {
    entries
      .filter(entry => entry.isIntersecting)
      .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
      .forEach((entry, i) => {
        revealElement(entry.target, i);
        observer.unobserve(entry.target);
      });
  }, OBSERVER_OPTIONS);

  // Anything already in view reveals immediately rather than waiting for the
  // observer's first callback — otherwise the page paints blank above the fold
  // for a frame or two on load, which is the whole screen on this layout.
  const aboveFold = [];
  els.forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0) aboveFold.push(el);
    else observer.observe(el);
  });
  aboveFold.sort(sortByTop).forEach(revealElement);

  setTimeout(() => {
    els.forEach((el) => {
      if (el.classList.contains('is-visible')) return;
      observer.unobserve(el);
      el.classList.add('is-visible');
    });
  }, REVEAL_FALLBACK_MS);
}

/**
 * Name the gameweek the app is currently pointed at, replacing the static
 * fallback copy in index.html. Silent no-op until data lands, so a dead FPL
 * proxy leaves the generic wording in place rather than a broken "Gameweek
 * undefined".
 */
function renderGameweek() {
  const slot = root?.querySelector('[data-landing-gw]');
  if (!slot) return;

  const gw = store.getCurrentGw() ?? store.getNextGw();
  if (!gw) return;

  slot.textContent = `Live for Gameweek ${gw}`;
}

/** Show or hide the app chrome, and run the reveal the first time we are shown. */
function onRouteChanged(moduleKey) {
  const isLanding = moduleKey === MODULE_KEY;
  document.body.classList.toggle('is-landing', isLanding);

  if (!isLanding || hasRevealed) return;
  hasRevealed = true;
  initReveal();
}

/**
 * Wire the landing route. Called once from main.js, after routeToHash() has
 * already seeded store.activeModule — so the initial route:changed emit has
 * been and gone, and the current route is read directly here instead.
 */
export function initLanding() {
  root = document.querySelector(`[data-module="${MODULE_KEY}"]`);
  if (!root) return;

  store.subscribe('route:changed', onRouteChanged);
  store.subscribe('data:ready', renderGameweek);

  onRouteChanged(store.getActiveModule());
}
