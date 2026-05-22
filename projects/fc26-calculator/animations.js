/* ───────────────────────────────────────────────────────────────
   ANIMATIONS & MICRO-INTERACTIONS
   Smooth collapsibles, hover effects, haptic feedback.
   Layered on top of the core logic — never modifies it.
   ─────────────────────────────────────────────────────────────── */
(function() {
  'use strict';

  const REDUCED_MOTION = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── 1. Smooth collapsibles ─────────────────────────────────
     The original JS toggles .open on .collapsible-body / .folder-contents.
     We watch for that and animate max-height accordingly. After the
     opening transition completes we set max-height: none so dynamic
     content (e.g. typing in inputs, adding saves) can grow freely.
     ─────────────────────────────────────────────────────────── */
  function setupCollapsible(el) {
    if (el.dataset.collapsibleSetup === '1') return;
    el.dataset.collapsibleSetup = '1';

    // Initial state without transition
    const wasOpen = el.classList.contains('open');
    const prevTransition = el.style.transition;
    el.style.transition = 'none';
    el.style.maxHeight = wasOpen ? 'none' : '0px';
    if (wasOpen) el.style.opacity = '1';
    void el.offsetHeight;             // commit
    el.style.transition = prevTransition;

    const obs = new MutationObserver(() => {
      const isOpen = el.classList.contains('open');
      if (isOpen) {
        // OPENING — expand to scrollHeight, then release to 'none'
        if (el.style.maxHeight === 'none') return;
        const target = el.scrollHeight;
        el.style.maxHeight = target + 'px';
        const onEnd = (ev) => {
          if (ev.propertyName !== 'max-height') return;
          el.removeEventListener('transitionend', onEnd);
          if (el.classList.contains('open')) el.style.maxHeight = 'none';
        };
        el.addEventListener('transitionend', onEnd);
      } else {
        // CLOSING — if currently 'none', lock to scrollHeight first to enable transition
        if (el.style.maxHeight === 'none') {
          el.style.maxHeight = el.scrollHeight + 'px';
          void el.offsetHeight;       // commit
        }
        requestAnimationFrame(() => { el.style.maxHeight = '0px'; });
      }
    });
    obs.observe(el, { attributes: true, attributeFilter: ['class'] });
  }

  function setupAllCollapsibles() {
    document.querySelectorAll('.collapsible-body, .folder-contents')
      .forEach(setupCollapsible);
  }
  setupAllCollapsibles();

  /* New folders are added dynamically via the saves system — re-scan when
     savedPlayersList children change. */
  const savedList = document.getElementById('savedPlayersList');
  if (savedList) {
    new MutationObserver(setupAllCollapsibles)
      .observe(savedList, { childList: true, subtree: true });
  }

  /* ── 2. Scroll-triggered card reveal ────────────────────────
     IntersectionObserver adds .is-visible the first time each card
     scrolls into view, with a small per-card stagger so a viewport
     full of cards reveals in cascade rather than all at once.
     ─────────────────────────────────────────────────────────── */
  const cards = document.querySelectorAll('section.card-enter');
  if (REDUCED_MOTION) {
    cards.forEach(c => { c.classList.add('is-visible'); c.style.willChange = 'auto'; });
  } else {
    let revealedCount = 0;
    let settledCount = 0;
    const totalCards = cards.length;
    const reveal = new IntersectionObserver((entries) => {
      // Sort entries top-down so stagger order is visually correct
      entries
        .filter(e => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        .forEach(e => {
          const delay = Math.min(revealedCount * 90, 360);
          revealedCount++;
          const target = e.target;
          setTimeout(() => {
            target.classList.add('is-visible');
            // Reveal is one-shot — drop the compositor hint once the
            // transition has finished so the layer can be released.
            setTimeout(() => { target.style.willChange = 'auto'; }, 820);
          }, delay);
          reveal.unobserve(target);
          // Stop observing entirely once every card has fired.
          if (++settledCount >= totalCards) reveal.disconnect();
        });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
    cards.forEach(c => reveal.observe(c));
  }

  /* ── 3. Number flash — pulse stat values when they update ──
     We watch the effective stat / sub-stat / delta numbers for text
     changes and pulse them to celebrate the update.

     The previous implementation gave every readout its own
     MutationObserver and, on each mutation, did
     `remove(class) → void offsetHeight → add(class)` to restart the
     CSS animation. Because the numbers tween over ~16 frames, that
     fired ~16× per number per calculate, and each `offsetHeight`
     read is a *synchronous forced reflow* — ~300+ per calculate.

     Now: ONE observer for all readouts; the pulse runs through the
     Web Animations API (no class churn, no forced reflow); and a
     leading-edge cooldown collapses the whole tween burst into a
     single clean pulse instead of 16 restarts.
     ─────────────────────────────────────────────────────────── */
  if (!REDUCED_MOTION) {
    const FLASH_MS = 540;
    const FLASH_KEYFRAMES = [
      { transform: 'translateY(0)',    filter: 'brightness(1)' },
      { transform: 'translateY(-2px)', filter: 'brightness(1.3)', offset: 0.35 },
      { transform: 'translateY(0)',    filter: 'brightness(1)' },
    ];
    const FLASH_OPTS = { duration: FLASH_MS, easing: 'cubic-bezier(0.32, 0.72, 0.24, 1)' };
    const flashLast = new WeakMap();
    const flashCooldown = new WeakMap();

    const flashEl = (el) => {
      const now = performance.now();
      if (now < (flashCooldown.get(el) || 0)) return;   // mid-burst — skip
      flashCooldown.set(el, now + FLASH_MS);
      // WAAPI restart is layout-free; no class toggle, no offsetHeight.
      el.animate(FLASH_KEYFRAMES, FLASH_OPTS);
    };

    const flashObserver = new MutationObserver((records) => {
      const seen = new Set();
      for (const r of records) {
        const el = r.target.nodeType === 3 ? r.target.parentNode : r.target;
        if (!el || seen.has(el)) continue;
        seen.add(el);
        const txt = el.textContent;
        if (flashLast.get(el) !== txt) {
          flashLast.set(el, txt);
          flashEl(el);
        }
      }
    });

    document.querySelectorAll('.stat-effective-num, .sub-stat-num, .delta')
      .forEach(el => {
        flashLast.set(el, el.textContent);
        flashObserver.observe(el, { childList: true, characterData: true, subtree: true });
      });
  }

  /* ── 4. Tactile haptics on button press (if available) ──────
     Lightly buzz the device on selection actions where a meaningful
     state change happens. Silently no-ops when unsupported.
     ─────────────────────────────────────────────────────────── */
  const tactileSelectors = '.ps-btn, .option-btn, .role-chip, .archetype-chip';
  document.addEventListener('click', (e) => {
    const btn = e.target.closest(tactileSelectors);
    if (btn && navigator.vibrate) navigator.vibrate(8);
  }, { passive: true });

})();
