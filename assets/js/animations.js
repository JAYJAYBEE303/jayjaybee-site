/* =========================================================================
   jayjaybee.com — animations.js
   Vanilla JS, no build step. Two IIFEs, kept separate for clarity:

     1. Core interactions — theme toggle, nav dropdowns.
     2. Motion          — reveal-on-scroll, dropdown stagger, haptics,
                          anchor-close behaviour.

   Hidden-state CSS lives in style.css (scoped to .js) so it takes effect
   at parse time — no flicker, no class-tagging race. This file just
   promotes elements to .is-visible as they enter the viewport.
   ========================================================================= */

/* =========================================================================
   1. CORE INTERACTIONS
   ========================================================================= */
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Theme toggle
  //
  // Cycles through three states: system → light → dark → system.
  // The very first paint is handled by the inline script in <head> so the
  // page never flashes the wrong palette. This block owns user-driven
  // changes only.
  // -------------------------------------------------------------------------
  var THEME_KEY = 'theme';                       // localStorage key
  var STATES   = ['system', 'light', 'dark'];    // cycle order
  var GLYPHS   = { system: '◐', light: '○', dark: '●' };
  var LABELS   = { system: 'System', light: 'Light', dark: 'Dark' };

  var root   = document.documentElement;
  var toggle = document.getElementById('theme-toggle');
  if (!toggle) return;

  var labelEl = toggle.querySelector('[data-theme-label]');

  /** Read current state from storage. Falls back to 'system'. */
  function currentState () {
    try {
      var saved = localStorage.getItem(THEME_KEY);
      if (saved === 'light' || saved === 'dark') return saved;
    } catch (e) {}
    return 'system';
  }

  /** Apply a state: write to DOM + storage + button label. */
  function applyState (next) {
    if (next === 'system') {
      root.removeAttribute('data-theme');
      try { localStorage.removeItem(THEME_KEY); } catch (e) {}
    } else {
      root.setAttribute('data-theme', next);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
    }
    paintToggle(next);
  }

  /** Refresh the toggle's visible label + glyph. */
  function paintToggle (state) {
    toggle.setAttribute('data-glyph', GLYPHS[state]);
    toggle.setAttribute('data-state', state);
    toggle.setAttribute(
      'aria-label',
      'Colour theme: ' + LABELS[state] + ' (click to change)'
    );
    if (labelEl) labelEl.textContent = LABELS[state];
  }

  // Initial paint
  paintToggle(currentState());

  // Click → advance state. The brief micro-animation is purely cosmetic;
  // the actual DOM change happens at the midpoint so the swap is masked
  // by the fade.
  toggle.addEventListener('click', function () {
    var cur  = currentState();
    var next = STATES[(STATES.indexOf(cur) + 1) % STATES.length];

    // Respect reduced-motion users — swap immediately.
    var prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) { applyState(next); return; }

    toggle.classList.add('is-changing');
    window.setTimeout(function () { applyState(next); }, 100);
    window.setTimeout(function () {
      toggle.classList.remove('is-changing');
    }, 220);
  });

  // If the user is on 'system' and their OS preference changes, re-paint
  // the label so it stays honest. (The CSS already reacts to the media
  // query — this just keeps the button in sync.)
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function () {
      if (currentState() === 'system') paintToggle('system');
    };
    if (mq.addEventListener)      mq.addEventListener('change', onChange);
    else if (mq.addListener)      mq.addListener(onChange);
  }

  // -------------------------------------------------------------------------
  // Nav dropdowns
  //
  // Click a trigger to open its panel; click again, click outside, or press
  // Escape to close. Only one open at a time. Buttons own aria-expanded;
  // panels own [hidden]. No CSS-only :hover open — needs to work on touch.
  // -------------------------------------------------------------------------
  var triggers = document.querySelectorAll('[data-menu-trigger]');
  if (triggers.length) {
    var openTrigger = null;

    function closeMenu (trigger) {
      if (!trigger) return;
      var id = trigger.getAttribute('aria-controls');
      var panel = id && document.getElementById(id);
      trigger.setAttribute('aria-expanded', 'false');
      if (panel) panel.hidden = true;
      if (openTrigger === trigger) openTrigger = null;
    }

    function openMenu (trigger) {
      if (openTrigger && openTrigger !== trigger) closeMenu(openTrigger);
      var id = trigger.getAttribute('aria-controls');
      var panel = id && document.getElementById(id);
      trigger.setAttribute('aria-expanded', 'true');
      if (panel) panel.hidden = false;
      openTrigger = trigger;
    }

    triggers.forEach(function (trigger) {
      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        var expanded = trigger.getAttribute('aria-expanded') === 'true';
        if (expanded) closeMenu(trigger);
        else openMenu(trigger);
      });
    });

    // Click outside closes any open menu.
    document.addEventListener('click', function (e) {
      if (!openTrigger) return;
      var id = openTrigger.getAttribute('aria-controls');
      var panel = id && document.getElementById(id);
      if (panel && panel.contains(e.target)) return;
      if (openTrigger.contains(e.target)) return;
      closeMenu(openTrigger);
    });

    // Escape closes the open menu and returns focus to its trigger.
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !openTrigger) return;
      var t = openTrigger;
      closeMenu(t);
      t.focus();
    });
  }
})();

/* =========================================================================
   2. MOTION

     a. Reveal-on-scroll for major elements (boot + scroll cascade).
     b. Per-item stagger when a nav dropdown opens.
     c. Tactile haptic on meaningful clicks.
     d. Anchor clicks close any open dropdown before the scroll glides.
   ========================================================================= */
(function () {
  'use strict';

  var REDUCED_MOTION =
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Mirror of the selector group in style.css. Keep both in sync.
  // (Listed top-down so the boot cascade reveals in reading order.)
  var REVEAL_SELECTOR = [
    '.site-wordmark',
    '.site-nav__list > li',
    '.lede-meta',
    '.lede-line',
    '.narrative .prose',
    '.roles .section-head',
    '.role-item',
    '.work  .section-head',
    '.work-item',
    '.currently .section-head',
    '.now-item',
    '.footer-block',
    '.footer-rule'
  ].join(', ');

  // -------------------------------------------------------------------------
  // a. Reveal system
  // -------------------------------------------------------------------------
  function setupReveal() {
    var els = document.querySelectorAll(REVEAL_SELECTOR);
    if (!els.length) return;

    if (REDUCED_MOTION || !('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('is-visible'); });
      return;
    }

    // Stagger: siblings in the same batch reveal a beat apart; cumulative
    // delay is capped so large batches don't feel sluggish.
    var perItemDelay  = 70;   // ms between siblings
    var maxBatchDelay = 360;  // ms cap

    var io = new IntersectionObserver(function (entries) {
      var visible = entries
        .filter(function (e) { return e.isIntersecting; })
        .sort(function (a, b) {
          return a.boundingClientRect.top - b.boundingClientRect.top;
        });

      if (!visible.length) return;

      visible.forEach(function (entry, i) {
        var el = entry.target;
        var delay = Math.min(i * perItemDelay, maxBatchDelay);
        el.style.setProperty('--reveal-delay', delay + 'ms');
        // Defer one frame so the delay variable is committed before the
        // class flip kicks off the transition.
        requestAnimationFrame(function () {
          el.classList.add('is-visible');
        });
        io.unobserve(el);
      });
    }, {
      rootMargin: '0px 0px -8% 0px',
      threshold: 0.06
    });

    els.forEach(function (el) { io.observe(el); });
  }

  // -------------------------------------------------------------------------
  // b. Dropdown menu — per-item stagger on open
  // -------------------------------------------------------------------------
  function setupMenuStagger() {
    document.querySelectorAll('[data-menu]').forEach(function (panel) {
      var items = panel.querySelectorAll('.site-nav__menu-link');
      items.forEach(function (item, i) {
        var delay = REDUCED_MOTION ? 0 : Math.min(40 + i * 35, 240);
        item.style.setProperty('--menu-item-delay', delay + 'ms');
      });
    });
  }

  // -------------------------------------------------------------------------
  // c. Tactile haptics
  // -------------------------------------------------------------------------
  var TACTILE_SELECTORS = [
    '.site-nav__trigger',
    '.site-nav__menu-link',
    '.theme-toggle',
    '.work-link',
    '.role-title',
    '.footer-links a'
  ].join(', ');

  function setupHaptics() {
    if (REDUCED_MOTION || !navigator.vibrate) return;
    document.addEventListener('click', function (e) {
      if (e.target.closest(TACTILE_SELECTORS)) {
        navigator.vibrate(8);
      }
    }, { passive: true });
  }

  // -------------------------------------------------------------------------
  // d. Anchor navigation
  //
  // Intercept clicks on any link whose hash points to an element on the
  // current page (handles both "#foo" and rooted "/#foo" forms — the
  // layout uses the rooted form so the nav works from sub-pages too).
  //
  // For matched clicks we:
  //   1. Close any open nav dropdown (replaces the old setupAnchorClose).
  //   2. Mark the target with .is-targeted so the design system's role
  //      highlight still fires once we strip the hash from the URL.
  //   3. Smooth-scroll to the target (respecting reduced-motion).
  //   4. Replace the URL state so the address bar stays clean — no
  //      "#exp-amf1" hanging off the end after the user clicks.
  //
  // The skip-link is excluded so screen-reader / keyboard users keep the
  // browser's default focus-jump behaviour.
  // -------------------------------------------------------------------------
  function setupAnchorScroll() {
    document.addEventListener('click', function (e) {
      var link = e.target.closest('a');
      if (!link || link.classList.contains('skip-link')) return;

      var href = link.getAttribute('href');
      if (!href) return;

      // Resolve to a URL so we can compare path + hash regardless of href form.
      var url;
      try { url = new URL(href, window.location.href); } catch (err) { return; }

      // Only intercept same-origin, same-path links with a real hash.
      if (url.origin   !== window.location.origin)   return;
      if (url.pathname !== window.location.pathname) return;
      if (!url.hash || url.hash === '#')             return;

      // Bail if the target doesn't exist on this page (e.g. dropdown link
      // copied onto a page that doesn't contain the role list).
      var target;
      try { target = document.querySelector(url.hash); } catch (err) { return; }
      if (!target) return;

      e.preventDefault();

      // Close any open dropdown — defer one tick so the core outside-click
      // handler runs first without us double-toggling.
      var openTrigger = document.querySelector('.site-nav__trigger[aria-expanded="true"]');
      if (openTrigger) {
        setTimeout(function () {
          if (openTrigger.getAttribute('aria-expanded') === 'true') {
            openTrigger.click();
          }
        }, 0);
      }

      // Move the .is-targeted class onto the new destination. Pairs with the
      // ".role-item:target, .role-item.is-targeted" rule in layout.css so the
      // vermillion left rule still appears once the URL hash is gone.
      document.querySelectorAll('.is-targeted').forEach(function (el) {
        el.classList.remove('is-targeted');
      });
      target.classList.add('is-targeted');

      target.scrollIntoView({
        behavior: REDUCED_MOTION ? 'auto' : 'smooth',
        block:    'start'
      });

      // Strip the hash from the address bar without adding a history entry.
      history.replaceState(null, '', window.location.pathname + window.location.search);
    });
  }

  // -------------------------------------------------------------------------
  // Boot
  // -------------------------------------------------------------------------
  function boot() {
    setupReveal();
    setupMenuStagger();
    setupHaptics();
    setupAnchorScroll();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
