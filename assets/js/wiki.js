/* =========================================================================
   jayjaybee.com — wiki.js
   Loaded only by _layouts/wiki-entry.html, i.e. only on /projects/wiki/<slug>/.

   Progressive enhancement only. Everything this file does is optional:
   the entry's prose, its internal links, its footnotes, backlinks and
   pager are all compiled at build time (see _includes/wiki-body.html), so
   with JavaScript off the page still reads and navigates correctly. All
   that is lost is the on-this-page rail and the hover preview.

   Two jobs:
     1. Build the "On this page" list from the article's own h2/h3, and
        keep the current section marked as the reader scrolls.
     2. Show a small preview card when the reader hovers an internal wiki
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
     2. Hover preview
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
})();
