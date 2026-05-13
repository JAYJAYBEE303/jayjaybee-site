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
    cards.forEach(c => c.classList.add('is-visible'));
  } else {
    let revealedCount = 0;
    const reveal = new IntersectionObserver((entries) => {
      // Sort entries top-down so stagger order is visually correct
      entries
        .filter(e => e.isIntersecting)
        .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        .forEach(e => {
          const delay = Math.min(revealedCount * 90, 360);
          revealedCount++;
          setTimeout(() => e.target.classList.add('is-visible'), delay);
          reveal.unobserve(e.target);
        });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
    cards.forEach(c => reveal.observe(c));
  }

  /* ── 3. Number flash — pulse stat values when they update ──
     We watch the effective stat / sub-stat / delta numbers for text
     changes and add a brief .flash class to celebrate the update.
     ─────────────────────────────────────────────────────────── */
  if (!REDUCED_MOTION) {
    const flashTargets = document.querySelectorAll(
      '.stat-effective-num, .sub-stat-num, .delta'
    );
    flashTargets.forEach(el => {
      let last = el.textContent;
      const pulse = () => {
        el.classList.remove('flash');
        void el.offsetHeight;
        el.classList.add('flash');
      };
      new MutationObserver(() => {
        if (el.textContent !== last) {
          last = el.textContent;
          pulse();
        }
      }).observe(el, { childList: true, characterData: true, subtree: true });
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
