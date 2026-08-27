/* =========================================================================
   jayjaybee.com — wiki.js
   Loaded only by _layouts/wiki-entry.html, i.e. only on
   /projects/wiki/<app>/<section>/.

   Progressive enhancement only. Everything this file does is optional:
   the entry's prose, its internal links, its footnotes, backlinks and
   pager are all compiled at build time (see _includes/wiki-body.html), so
   with JavaScript off the page still reads and navigates correctly. All
   that is lost is the on-this-page rail, the rail filter, the Recently
   read list, and the popovers (infobox term definitions and the link
   hover preview).

   Five jobs:
     1. Build the "On this page" list from the section's own h2/h3, and
        keep the current heading marked as the reader scrolls.
     2. Inject and run the rail filter.
     3. Keep the Recently read list, in this browser only.
     4. Open a definition when an infobox term is clicked.
     5. Show a small preview card when the reader hovers an internal wiki
        link. The card's content comes from data-peek-* attributes the
        build already wrote onto each link — no manifest, no fetch.
   ========================================================================= */
(function () {
  'use strict';

  var body = document.getElementById('wk-body');
  if (!body) return;

  var reduce = window.matchMedia &&
               window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* =======================================================================
     1. On this page
     ======================================================================= */

  var tocNav   = document.getElementById('wk-toc');
  var tocBlock = document.getElementById('wk-toc-block');
  var links    = [];
  var targets  = [];

  function slugify (text) {
    return text.toLowerCase()
               .replace(/[^\w\s-]/g, '')
               .trim()
               .replace(/\s+/g, '-');
  }

  function buildToc () {
    if (!tocNav || !tocBlock) return;

    targets = Array.prototype.slice.call(body.querySelectorAll('h2, h3'));
    if (!targets.length) return;

    var used = {};
    targets.forEach(function (h) {
      if (h.id) return;
      var base = slugify(h.textContent) || 'section';
      var id = base;
      // Two headings with the same words would otherwise collide and the
      // second anchor would jump to the first.
      var n = 2;
      while (used[id] || document.getElementById(id)) { id = base + '-' + n; n++; }
      used[id] = true;
      h.id = id;
    });

    tocNav.innerHTML = targets.map(function (h) {
      var cls = h.tagName === 'H3' ? ' class="is-sub"' : '';
      var a = document.createElement('a');
      a.textContent = h.textContent;
      return '<a href="#' + h.id + '"' + cls + '>' + a.innerHTML + '</a>';
    }).join('');

    links = Array.prototype.slice.call(tocNav.querySelectorAll('a'));
    tocBlock.classList.add('is-built');
    spy();
  }

  // The site header does not stick, so the only offset needed is enough
  // slack that a heading counts as "current" slightly before its top edge
  // reaches the viewport top. --space-7 (48px) is that slack.
  var SPY_SLACK = 48;

  function spy () {
    if (!targets.length || !links.length) return;
    var line = window.scrollY + SPY_SLACK + 1;
    var active = 0;
    targets.forEach(function (h, i) {
      if (h.getBoundingClientRect().top + window.scrollY <= line) active = i;
    });
    links.forEach(function (a, i) { a.classList.toggle('is-active', i === active); });
  }

  var ticking = false;
  window.addEventListener('scroll', function () {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(function () { spy(); ticking = false; });
  }, { passive: true });

  /* =======================================================================
     2. Rail filter

     Injected rather than authored into the rail, so with JS off there is
     no dead control. Filtering is over data attributes the build already
     wrote onto each row — no index, no fetch.

     Row numbers are NOT rewritten when the rail narrows: 07 identifies
     the section, not its position in a filtered list.
     ======================================================================= */

  var filterMount = document.getElementById('wk-rail-filter');

  function buildFilter () {
    if (!filterMount) return;

    var items  = Array.prototype.slice.call(document.querySelectorAll('[data-rail-item]'));
    var groups = Array.prototype.slice.call(document.querySelectorAll('[data-rail-group]'));
    if (items.length < 2) return;

    var wrap = document.createElement('div');
    wrap.className = 'wk-filter';

    var input = document.createElement('input');
    input.type = 'text';
    input.id = 'wk-filter-input';
    input.placeholder = 'Filter entries';
    input.autocomplete = 'off';
    input.setAttribute('aria-label', 'Filter sections');

    var empty = document.createElement('p');
    empty.className = 'wk-rail__empty';
    empty.textContent = 'No section matches.';
    empty.hidden = true;

    wrap.appendChild(input);
    filterMount.appendChild(wrap);
    filterMount.appendChild(empty);

    function apply () {
      var q = input.value.trim().toLowerCase();
      var total = 0;

      groups.forEach(function (g) {
        var rows = Array.prototype.slice.call(g.querySelectorAll('[data-rail-item]'));
        var shown = 0;

        rows.forEach(function (a) {
          var hit = !q ||
                    (a.getAttribute('data-title') || '').indexOf(q) > -1 ||
                    (a.getAttribute('data-lede')  || '').indexOf(q) > -1;
          a.hidden = !hit;
          if (hit) shown++;
        });

        g.hidden = shown === 0;
        total += shown;

        var count = g.querySelector('[data-rail-count]');
        if (count) count.textContent = shown < 10 ? '0' + shown : String(shown);
      });

      empty.hidden = total !== 0;
    }

    input.addEventListener('input', apply);
    // Escape clears rather than closes — there is nothing to close.
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && input.value) {
        ev.preventDefault();
        input.value = '';
        apply();
      }
    });
  }

  /* =======================================================================
     3. Recently read

     Five most recent sections, newest first, in this browser only. Every
     access is wrapped because localStorage throws outright in some
     privacy modes rather than returning null.

     Titles are stored alongside slugs so a row can be drawn without a
     manifest of every section in the wiki.
     ======================================================================= */

  var RECENT_KEY = 'wk-recent-v1';
  var RECENT_MAX = 5;

  function readRecent () {
    try {
      var raw = window.localStorage.getItem(RECENT_KEY);
      var list = raw ? JSON.parse(raw) : [];
      return Object.prototype.toString.call(list) === '[object Array]' ? list : [];
    } catch (e) { return []; }
  }

  function writeRecent (list) {
    try { window.localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch (e) {}
  }

  function buildRecent () {
    var mount = document.getElementById('wk-recent');
    var block = document.getElementById('wk-recent-block');
    var title = document.getElementById('wk-title');
    if (!mount || !block || !title) return;

    var here = { url: window.location.pathname, title: title.textContent };

    var list = readRecent().filter(function (r) {
      return r && r.url && r.title && r.url !== here.url;
    });
    list.unshift(here);
    list = list.slice(0, RECENT_MAX);
    writeRecent(list);

    mount.innerHTML = '';
    list.forEach(function (r) {
      var a = document.createElement('a');
      a.href = r.url;
      a.textContent = r.title;
      if (r.url === here.url) a.setAttribute('aria-current', 'page');
      mount.appendChild(a);
    });

    block.classList.add('is-built');
  }

  /* =======================================================================
     4. Glossary popover

     One element appended to <body>, same reason as the hover peek: its
     absolute coordinates are then page coordinates whatever the
     article's layout is doing.

     Content comes from data attributes the build wrote onto the button,
     so the glossary itself is never shipped as JavaScript.
     ======================================================================= */

  var pop = null;
  var openTerm = null;

  function ensurePop () {
    if (pop) return pop;
    pop = document.createElement('div');
    pop.className = 'wk-pop';
    pop.setAttribute('role', 'dialog');
    pop.setAttribute('aria-label', 'Term detail');
    document.body.appendChild(pop);
    return pop;
  }

  function closePop () {
    if (openTerm) openTerm.setAttribute('aria-expanded', 'false');
    openTerm = null;
    if (pop) pop.classList.remove('is-on');
  }

  function openPop (btn) {
    var el = ensurePop();
    el.innerHTML = '';

    var kind = document.createElement('p');
    kind.className = 'wk-pop__kind mono-label';
    var kindText = document.createElement('span');
    kindText.textContent = btn.getAttribute('data-term-kind') || 'Term';
    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'wk-pop__x';
    x.setAttribute('data-pop-close', '');
    x.setAttribute('aria-label', 'Close');
    x.textContent = '✕';
    kind.appendChild(kindText);
    kind.appendChild(x);
    el.appendChild(kind);

    var term = document.createElement('p');
    term.className = 'wk-pop__term';
    term.textContent = btn.textContent.trim();
    el.appendChild(term);

    var bodyEl = document.createElement('p');
    bodyEl.className = 'wk-pop__body';
    bodyEl.textContent = btn.getAttribute('data-term-text') || '';
    el.appendChild(bodyEl);

    var href = btn.getAttribute('data-term-href');
    if (href) {
      var ref = document.createElement('a');
      ref.className = 'wk-pop__ref mono-label';
      ref.href = href;
      ref.textContent = 'Full entry: ' + (btn.getAttribute('data-term-ref') || '') + ' →';
      el.appendChild(ref);
    }

    // Measure while shown but invisible, then place: below the term if it
    // fits, above if it does not, and never past the right edge.
    el.style.visibility = 'hidden';
    el.classList.add('is-on');
    var r = btn.getBoundingClientRect();
    var h = el.offsetHeight;
    var w = el.offsetWidth;
    var top = r.bottom + window.scrollY + 8;
    if (r.bottom + h + 16 > window.innerHeight && r.top - h - 8 > 0) {
      top = r.top + window.scrollY - h - 8;
    }
    var left = r.left + window.scrollX + (r.width / 2) - (w / 2);
    left = Math.min(left, window.scrollX + document.documentElement.clientWidth - w - 16);
    el.style.top  = Math.max(window.scrollY + 8, top) + 'px';
    el.style.left = Math.max(8, left) + 'px';
    el.style.visibility = 'visible';

    btn.setAttribute('aria-expanded', 'true');
    openTerm = btn;
  }

  function bindPop () {
    document.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('button.wk-term') : null;
      if (btn) {
        ev.preventDefault();
        // A second click on the open term closes it.
        if (btn === openTerm) { closePop(); return; }
        closePop();
        openPop(btn);
        return;
      }
      if (ev.target.closest && ev.target.closest('[data-pop-close]')) { closePop(); return; }
      if (ev.target.closest && ev.target.closest('.wk-pop')) return;
      closePop();
    });

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && openTerm) { ev.preventDefault(); closePop(); }
    });

    window.addEventListener('resize', closePop);
  }

  /* =======================================================================
     5. Hover preview
     ======================================================================= */

  var peek = null;
  var timer = null;

  function ensurePeek () {
    if (peek) return peek;
    peek = document.createElement('div');
    peek.className = 'wk-peek';
    // Appended to <body> so its absolute coordinates are page coordinates,
    // whatever the article's own layout is doing.
    document.body.appendChild(peek);
    return peek;
  }

  function showPeek (a) {
    var kind  = a.getAttribute('data-peek-kind');
    var title = a.getAttribute('data-peek-title');
    var lede  = a.getAttribute('data-peek-lede');
    if (!title) return;

    var el = ensurePeek();
    el.innerHTML = '';

    if (kind) {
      var k = document.createElement('p');
      k.className = 'wk-peek__kind mono-label';
      k.textContent = kind;
      el.appendChild(k);
    }
    var t = document.createElement('p');
    t.className = 'wk-peek__title';
    t.textContent = title;
    el.appendChild(t);
    if (lede) {
      var l = document.createElement('p');
      l.className = 'wk-peek__lede';
      l.textContent = lede;
      el.appendChild(l);
    }

    // Measure while hidden, then place: below the link if it fits, above
    // if it doesn't, and never past the right edge of the document.
    el.style.visibility = 'hidden';
    el.classList.add('is-on');
    var r = a.getBoundingClientRect();
    var h = el.offsetHeight;
    var w = el.offsetWidth;
    var top = r.bottom + window.scrollY + 8;
    if (r.bottom + h + 16 > window.innerHeight) top = r.top + window.scrollY - h - 8;
    var left = Math.min(r.left + window.scrollX,
                        window.scrollX + document.documentElement.clientWidth - w - 16);
    el.style.top  = Math.max(window.scrollY + 8, top) + 'px';
    el.style.left = Math.max(8, left) + 'px';
    el.style.visibility = 'visible';
  }

  function hidePeek () {
    clearTimeout(timer);
    if (peek) peek.classList.remove('is-on');
  }

  // Hover previews are a pointer affordance; skip them entirely for
  // reduced-motion and for touch, where there is no hover to speak of.
  var hoverable = window.matchMedia && window.matchMedia('(hover: hover)').matches;

  if (hoverable && !reduce) {
    document.addEventListener('mouseover', function (ev) {
      var a = ev.target.closest ? ev.target.closest('a.wl') : null;
      if (!a) return;
      clearTimeout(timer);
      timer = setTimeout(function () { showPeek(a); }, 180);
    });
    document.addEventListener('mouseout', function (ev) {
      var a = ev.target.closest ? ev.target.closest('a.wl') : null;
      if (!a) return;
      hidePeek();
    });
    window.addEventListener('scroll', hidePeek, { passive: true });
  }

  buildToc();
  buildFilter();
  buildRecent();
  bindPop();
})();
