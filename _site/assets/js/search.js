/* =========================================================================
   jayjaybee.com — search.js
   Vanilla JS, no build step. Owns the nav search component end-to-end:

     - Open/close UI state (`.is-open` + aria-expanded on the icon button).
     - Global "/" keypress to open from anywhere on the page.
     - Esc / blur / icon-toggle close behaviours, including a 150ms blur
       delay so chip clicks land before the panel collapses.
     - Chip → input.value + trigger.
     - Debounced typing search (200ms idle) and Enter to fire immediately.
     - Normalised text matching (case-insensitive, dashes → space,
       whitespace collapsed) while still wrapping the *original* page
       text so visible content is preserved exactly.
     - Match count + prev/next navigation.

   Search is scoped to <main id="main">; nav / footer / scripts / styles
   are excluded so the search component never highlights itself.
   ========================================================================= */
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // DOM references — bail out cleanly if the component isn't on the page.
  // -------------------------------------------------------------------------
  var search    = document.querySelector('[data-search]');
  if (!search) return;
  var toggleBtn = search.querySelector('[data-search-toggle]');
  var input     = search.querySelector('[data-search-input]');
  var countWrap = search.querySelector('[data-search-count]');
  var countText = search.querySelector('[data-search-count-text]');
  var prevBtn   = search.querySelector('[data-search-prev]');
  var nextBtn   = search.querySelector('[data-search-next]');
  var chips     = Array.prototype.slice.call(search.querySelectorAll('[data-search-chip]'));
  var main      = document.getElementById('main');
  if (!main || !toggleBtn || !input) return;

  // Per-tick state. `hits` is rebuilt on every search; `activeIdx` indexes
  // into it for prev/next navigation. `scrollCommitted` flags whether the
  // user has already triggered a scroll-action (Enter, chip, prev/next)
  // for the current `lastQuery` — used so a second Enter advances to the
  // next match instead of re-scrolling to the first.
  var hits            = [];
  var activeIdx       = -1;
  var blurTimer       = null;
  var debounceTimer   = null;
  var lastQuery       = '';
  var scrollCommitted = false;

  // Reduced-motion is read live so a system-pref change mid-session is
  // respected without a page reload.
  function prefersReducedMotion () {
    return window.matchMedia &&
           window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  // -------------------------------------------------------------------------
  // Open / close — toggles `.is-open` on .search and flips the button's
  // aria-expanded. Close also clears highlights + match-count state per
  // the spec ("On close: clear all highlights and reset match-count state").
  // -------------------------------------------------------------------------
  function isOpen () {
    return search.classList.contains('is-open');
  }

  function openSearch () {
    if (isOpen()) return;
    search.classList.add('is-open');
    toggleBtn.setAttribute('aria-expanded', 'true');
    // setTimeout lets the CSS width transition begin before the focus
    // grab — otherwise some browsers scroll the page on focus before
    // the input has any visible width.
    setTimeout(function () { input.focus(); }, 0);
  }

  function closeSearch () {
    if (!isOpen()) return;
    search.classList.remove('is-open');
    search.classList.remove('has-results');
    toggleBtn.setAttribute('aria-expanded', 'false');
    clearHighlights();
    countWrap.hidden = true;
    input.value = '';
    lastQuery = '';
    activeIdx = -1;
    scrollCommitted = false;
    updateNavButtons();
  }

  function toggleSearch () {
    isOpen() ? closeSearch() : openSearch();
  }

  toggleBtn.addEventListener('click', toggleSearch);

  // -------------------------------------------------------------------------
  // Global keys
  //   - Escape  → close + return focus to the toggle button
  //   - "/"     → open, unless the user is already typing in a field
  // -------------------------------------------------------------------------
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && isOpen()) {
      closeSearch();
      toggleBtn.focus();
      return;
    }
    if (e.key === '/' && !isOpen()) {
      var t = e.target;
      var tag = (t && t.tagName) ? t.tagName.toUpperCase() : '';
      // Don't hijack the slash when the user is composing somewhere.
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
      e.preventDefault();
      openSearch();
    }
  });

  // -------------------------------------------------------------------------
  // Blur close with a small delay so a click on a chip (which fires
  // mousedown → blur → click) doesn't collapse the panel before the
  // chip's click handler runs. The chip's mousedown handler also
  // preventDefault's to keep the input focused, but the delay is a
  // belt-and-braces fallback.
  // -------------------------------------------------------------------------
  input.addEventListener('blur', function () {
    blurTimer = setTimeout(function () {
      // Re-check focus: if focus has landed somewhere inside .search
      // (chip, prev/next), don't close.
      if (search.contains(document.activeElement)) return;
      if (isOpen()) closeSearch();
    }, 150);
  });
  input.addEventListener('focus', function () {
    if (blurTimer) { clearTimeout(blurTimer); blurTimer = null; }
  });

  // -------------------------------------------------------------------------
  // Chips — set input.value to the chip label and trigger a search.
  //   mousedown.preventDefault keeps the input focused (so blur doesn't
  //   fire and the panel doesn't try to close).
  // -------------------------------------------------------------------------
  chips.forEach(function (chip) {
    chip.addEventListener('mousedown', function (e) { e.preventDefault(); });
    chip.addEventListener('click', function () {
      input.value = chip.textContent.trim();
      input.focus();
      runSearch({ scroll: true });
    });
  });

  // -------------------------------------------------------------------------
  // Typing — debounce to 200ms idle. Enter cancels the debounce and runs
  // immediately. Debounced runs DON'T scroll (the user is still typing and
  // a jumpy page is disorienting); Enter and chip clicks DO scroll.
  // -------------------------------------------------------------------------
  input.addEventListener('input', function () {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      runSearch({ scroll: false });
    }, 200);
  });
  input.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }

    // If the user has already pressed Enter (or used prev/next, or a chip)
    // for this exact query, advance to the next match. Otherwise treat the
    // Enter as a "commit" — re-confirm/scroll to the first hit (rerunning
    // the search if anything has changed).
    var queryNorm = normaliseQuery(input.value);
    if (queryNorm && queryNorm === lastQuery && hits.length > 0) {
      if (scrollCommitted) {
        // Same query, already showed first match → step forward.
        moveActive(1);
      } else {
        // First Enter after debounced typing — scroll to the existing
        // active (first) hit without rebuilding the highlights.
        scrollToHit(hits[activeIdx]);
        scrollCommitted = true;
      }
      return;
    }

    // Query changed (or no hits yet) — run a fresh search with scroll.
    runSearch({ scroll: true });
  });

  // -------------------------------------------------------------------------
  // Prev / next match navigation. Disabled buttons short-circuit at the
  // click handler because some browsers still dispatch click on disabled
  // <button>s under specific conditions; defensive guard.
  // -------------------------------------------------------------------------
  prevBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
  nextBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
  prevBtn.addEventListener('click', function () {
    if (prevBtn.disabled) return;
    moveActive(-1);
  });
  nextBtn.addEventListener('click', function () {
    if (nextBtn.disabled) return;
    moveActive(1);
  });

  function moveActive (delta) {
    if (!hits.length) return;
    if (activeIdx >= 0 && hits[activeIdx]) {
      hits[activeIdx].classList.remove('active');
    }
    // Wrap around with positive modulo so -1 -> hits.length - 1.
    activeIdx = (activeIdx + delta + hits.length) % hits.length;
    var node = hits[activeIdx];
    node.classList.add('active');
    scrollToHit(node);
    // Any navigation action counts as committing the current query, so a
    // following Enter steps forward rather than re-scrolling to first.
    scrollCommitted = true;
  }

  // -------------------------------------------------------------------------
  // Reveal-and-scroll helpers
  //
  // ensureVisible: a hit may live inside a collapsed disclosure panel
  // (`.role-disclosure-panel` without `.is-open`). Walking up the ancestor
  // chain, we click the summary button for each closed panel so the user
  // actually sees the highlight. We re-use the existing disclosure button's
  // click handler in animations.js so the open animation (max-height +
  // transitionend bookkeeping) stays consistent.
  //
  // scrollToHit: defers the scroll if we just expanded a panel — until the
  // CSS max-height transition finishes the hit's bounding rect is still at
  // the panel's collapsed position, so an immediate scroll would land off
  // the highlight.
  // -------------------------------------------------------------------------
  function ensureVisible (hit) {
    var openedAny = false;
    var p = hit.parentNode;
    while (p && p !== main) {
      if (p.classList &&
          p.classList.contains('role-disclosure-panel') &&
          !p.classList.contains('is-open')) {
        // The summary <button> is the panel's previous sibling inside
        // the .role-disclosure wrapper. Click it to invoke the same
        // open animation a user-click would.
        var btn = p.previousElementSibling;
        if (btn && btn.classList.contains('role-disclosure-summary') &&
            btn.getAttribute('aria-expanded') !== 'true') {
          btn.click();
          openedAny = true;
        }
      }
      p = p.parentNode;
    }
    return openedAny;
  }

  function scrollToHit (hit) {
    var expanded = ensureVisible(hit);
    var behavior = prefersReducedMotion() ? 'auto' : 'smooth';
    var doScroll = function () {
      hit.scrollIntoView({ behavior: behavior, block: 'center' });
    };
    // The disclosure transition lasts ~300ms (open) per layout.css; wait
    // a touch longer than that so scrollIntoView reads the final position.
    if (expanded) {
      setTimeout(doScroll, 340);
    } else {
      doScroll();
    }
  }

  // -------------------------------------------------------------------------
  // Normalisation
  //   Lowercase, replace -/–/— with space, collapse runs of whitespace to
  //   a single space. We track for each normalised character the inclusive
  //   range of original-string indices that produced it, so a match found
  //   in the normalised string can be projected back to the original
  //   range — which is what we wrap with <mark> to preserve display text.
  // -------------------------------------------------------------------------
  function normChar (c) {
    // Dashes (hyphen, en-dash, em-dash) all collapse to a single space.
    if (c === '-' || c === '–' || c === '—') return ' ';
    // /\s/ matches ASCII whitespace and U+00A0 (non-breaking space) on
    // modern engines — important because the nav and prose use &nbsp;
    // in places like "Aston Martin Aramco Formula One™ Team".
    if (/\s/.test(c)) return ' ';
    return c.toLowerCase();
  }


  function normaliseText (text) {
    var out = '';
    var starts = []; // starts[i] = first original index that produced norm[i]
    var ends   = []; // ends[i]   = last original index that produced norm[i]
    var prevSpace = false;
    for (var i = 0; i < text.length; i++) {
      var nc = normChar(text.charAt(i));
      if (nc === ' ') {
        if (prevSpace) {
          // Extend the previous normalised char's "end" — runs of
          // whitespace map to a single space whose range covers all
          // contributing original characters.
          ends[ends.length - 1] = i;
          continue;
        }
        prevSpace = true;
      } else {
        prevSpace = false;
      }
      out += nc;
      starts.push(i);
      ends.push(i);
    }
    return { norm: out, starts: starts, ends: ends };
  }

  function normaliseQuery (q) {
    // Re-use normaliseText then strip leading/trailing single spaces
    // (the only spaces the normaliser can produce). Trimming here means
    // a query like "  jamf " behaves like "jamf".
    return normaliseText(q).norm.replace(/^ +| +$/g, '');
  }

  // -------------------------------------------------------------------------
  // Highlight clearing — replace every <mark.search-hit> with its inner
  // text and merge the surrounding text nodes back together so subsequent
  // searches operate on whole, untouched runs.
  // -------------------------------------------------------------------------
  function clearHighlights () {
    var marks = main.querySelectorAll('mark.search-hit');
    for (var i = 0; i < marks.length; i++) {
      var m = marks[i];
      var parent = m.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(m.textContent), m);
      parent.normalize();
    }
    hits = [];
    activeIdx = -1;
  }

  // -------------------------------------------------------------------------
  // Walk the main subtree, collecting candidate text nodes. Skip:
  //   - <script>, <style>, <noscript>, <iframe>, <mark> (existing
  //     highlights — defensive even though clearHighlights ran first).
  //   - Anything inside the search component itself.
  // -------------------------------------------------------------------------
  var EXCLUDED_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, IFRAME: 1, MARK: 1 };

  function isExcluded (node) {
    var p = node.parentNode;
    while (p && p !== main) {
      if (EXCLUDED_TAGS[p.nodeName]) return true;
      if (p.classList && p.classList.contains('search-hit')) return true;
      // Defensive: skip nodes inside any .search instance, though .search
      // lives in the header (outside #main) so this rarely triggers.
      if (p.classList && p.classList.contains('search')) return true;
      p = p.parentNode;
    }
    return false;
  }

  function collectTextNodes () {
    var nodes = [];
    var walker = document.createTreeWalker(
      main,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function (node) {
          if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
          // Skip pure whitespace nodes — nothing to match in them.
          if (!/\S/.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
          if (isExcluded(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      },
      false
    );
    var n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  }

  // -------------------------------------------------------------------------
  // Wrap a set of (start, end) ranges inside a single text node with
  // <mark.search-hit>. We build a fragment in one go so the index math
  // stays simple (no shifting as we mutate the DOM).
  // -------------------------------------------------------------------------
  function wrapRanges (textNode, ranges) {
    var text = textNode.nodeValue;
    var frag = document.createDocumentFragment();
    var cursor = 0;
    for (var i = 0; i < ranges.length; i++) {
      var start = ranges[i][0];
      var end   = ranges[i][1];
      if (start > cursor) {
        frag.appendChild(document.createTextNode(text.slice(cursor, start)));
      }
      var mark = document.createElement('mark');
      mark.className = 'search-hit';
      mark.textContent = text.slice(start, end);
      frag.appendChild(mark);
      cursor = end;
    }
    if (cursor < text.length) {
      frag.appendChild(document.createTextNode(text.slice(cursor)));
    }
    textNode.parentNode.replaceChild(frag, textNode);
  }

  // -------------------------------------------------------------------------
  // Main search routine — clears prior highlights, walks the main subtree,
  // wraps matches, updates the count + arrow state, and scrolls to the
  // first match.
  // -------------------------------------------------------------------------
  function runSearch (opts) {
    // `scroll` defaults to false — debounced typing should not jump the
    // page around. Enter, chip-clicks, and prev/next pass scroll: true.
    var shouldScroll = !!(opts && opts.scroll);
    var queryRaw  = input.value;
    var queryNorm = normaliseQuery(queryRaw);

    // Always clear before re-highlighting. Empty query → just clear and
    // hide the count row.
    clearHighlights();
    if (!queryNorm) {
      countWrap.hidden = true;
      search.classList.remove('has-results');
      lastQuery = '';
      scrollCommitted = false;
      updateNavButtons();
      return;
    }

    var nodes = collectTextNodes();
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var n = normaliseText(node.nodeValue);
      var norm = n.norm;
      if (!norm) continue;

      // Find all non-overlapping occurrences of queryNorm in norm.
      var ranges = [];
      var from = 0;
      while (from <= norm.length - queryNorm.length) {
        var idx = norm.indexOf(queryNorm, from);
        if (idx === -1) break;
        var origStart = n.starts[idx];
        var origEnd   = n.ends[idx + queryNorm.length - 1] + 1;
        ranges.push([origStart, origEnd]);
        from = idx + queryNorm.length;
      }
      if (ranges.length) wrapRanges(node, ranges);
    }

    hits = Array.prototype.slice.call(main.querySelectorAll('mark.search-hit'));
    lastQuery = queryNorm;

    countWrap.hidden = false;
    if (hits.length) {
      countText.textContent = hits.length + ' ' +
        (hits.length === 1 ? 'mention' : 'mentions') + ' found';
      activeIdx = 0;
      hits[0].classList.add('active');
      // Only scroll on explicit triggers; debounced typing just updates
      // the count + highlights in place. Track whether we scrolled so
      // a follow-up Enter knows to advance instead of re-scroll.
      if (shouldScroll) {
        scrollToHit(hits[0]);
        scrollCommitted = true;
      } else {
        scrollCommitted = false;
      }
      search.classList.add('has-results');
    } else {
      countText.textContent = 'No mentions found';
      search.classList.remove('has-results');
      scrollCommitted = false;
    }
    updateNavButtons();
  }

  // -------------------------------------------------------------------------
  // Prev/next are only meaningful when there's more than one match. The
  // CSS uses :disabled to drop their opacity to 30%.
  // -------------------------------------------------------------------------
  function updateNavButtons () {
    var many = hits.length > 1;
    prevBtn.disabled = !many;
    nextBtn.disabled = !many;
  }
})();
