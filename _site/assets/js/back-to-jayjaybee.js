/*!
 * jayjaybee.com — "back to jayjaybee.com" nav injector.
 *
 * Adds a "‹ jayjaybee.com" link back to the parent site on every page
 * that lives under /projects/. Include this file (plus its stylesheet,
 * /assets/css/back-to-jayjaybee.css) from any sub-project page — the
 * script itself verifies the current path before touching the DOM, so
 * a stray include on a non-project page fails safe and renders nothing.
 *
 * Detection strategy:
 *  - Path gate (hard requirement): only ever runs when the URL path
 *    contains a "/projects/" segment. This is checked first, before
 *    any other code runs, so nothing is built or rendered off-path.
 *  - Nav gate: looks for the page's own <nav> (or [role="navigation"])
 *    element. If that nav sits directly inside a <header> (or
 *    [role="banner"]) alongside other bar content — a logo/brand, in
 *    practice — the link is prepended to that outer bar instead, so it
 *    lands leftmost of the *entire* bar (left of the logo), not just
 *    leftmost of the nav's own links. Otherwise it's prepended as a new
 *    first item inside the nav itself. Either way it borrows the CSS
 *    classes of whatever nav item/link already sits in that slot (state
 *    classes like "is-active" are stripped), so it renders with that
 *    project's own font, color, spacing and hover behavior — nothing
 *    here hardcodes a look.
 *  - No <nav> found: the link floats fixed top-left instead, in the
 *    same "leftmost, top-level" spot a nav item would occupy, styled
 *    only with currentColor-derived chrome (see the stylesheet) so it
 *    still tracks the host page's own palette and typeface.
 */
(function () {
  'use strict';

  // Hard safeguard: bail out immediately for anything outside
  // /projects/, before any DOM work happens. Matches jayjaybee.com's
  // own path structure (jayjaybee.com/projects/<name>/...) and, for
  // local testing, the on-disk layout mirrors it (.../projects/<name>/...).
  if (!/(^|\/)projects\//i.test(window.location.pathname || '')) {
    return;
  }

  var LABEL = '‹ jayjaybee.com'; // "‹ jayjaybee.com" — U+2039, not "<"
  var HREF = 'https://jayjaybee.com';
  var MARKER = 'data-jjb-back-link';
  var STATE_CLASS_RE = /^(is-active|active|current|is-current|selected)$/i;

  function alreadyInjected() {
    return !!document.querySelector('[' + MARKER + ']');
  }

  function makeLink() {
    var a = document.createElement('a');
    a.href = HREF;
    a.textContent = LABEL;
    a.setAttribute(MARKER, '');
    a.classList.add('jjb-back-link');
    return a;
  }

  // Copy another element's classes onto `target`, skipping obvious
  // "this is the active/current page" state classes so the injected
  // link never renders as if it were selected.
  function borrowClasses(target, source) {
    var classes = source.className && source.className.baseVal !== undefined
      ? [] // SVG element (className is an SVGAnimatedString) — nothing to borrow
      : (source.className || '').split(/\s+/).filter(Boolean);
    for (var i = 0; i < classes.length; i++) {
      if (!STATE_CLASS_RE.test(classes[i])) target.classList.add(classes[i]);
    }
  }

  function findNav() {
    return document.querySelector('nav, [role="navigation"]');
  }

  // Work out where existing nav items live inside `nav` (directly, or
  // inside a <ul>/<ol>), and which element represents a single item —
  // the template we borrow styling from.
  function locateNavItemSlot(nav) {
    var list = nav.querySelector('ul, ol');
    var container = list || nav;
    return { container: container, template: container.firstElementChild };
  }

  // If `nav` lives directly inside a <header>/[role="banner"] alongside
  // other bar content (a brand/logo, controls, ...), that ancestor is the
  // real "nav bar" — return it so the link can be inserted leftmost of the
  // whole bar rather than just leftmost within the <nav> itself.
  function findOuterBar(nav) {
    var parent = nav.parentElement;
    if (!parent) return null;
    var isBanner = parent.tagName === 'HEADER' || parent.getAttribute('role') === 'banner';
    return isBanner ? parent : null;
  }

  // Reduce a nav-item template down to the link/button that actually
  // carries the nav's own class-based styling (unwrapping a <li> if needed).
  function resolveLinkTemplate(template) {
    if (!template) return null;
    return template.tagName === 'LI' ? template.querySelector('a, button') : template;
  }

  function injectIntoNav(nav) {
    var slot = locateNavItemSlot(nav);
    var link = makeLink();
    var outerBar = findOuterBar(nav);

    if (outerBar) {
      var linkTemplate = resolveLinkTemplate(slot.template);
      if (linkTemplate) {
        borrowClasses(link, linkTemplate);
      } else {
        link.classList.add('jjb-back-link--nav-fallback');
      }
      outerBar.insertBefore(link, outerBar.firstChild);
      return;
    }

    if (!slot.template) {
      // Nav bar exists but has no items to model — use built-in fallback look.
      link.classList.add('jjb-back-link--nav-fallback');
      slot.container.insertBefore(link, slot.container.firstChild);
      return;
    }

    if (slot.template.tagName === 'LI') {
      // List-based nav (<nav><ul><li><a>...) — wrap our link in a matching <li>.
      var li = document.createElement('li');
      borrowClasses(li, slot.template);
      var innerLink = slot.template.querySelector('a, button');
      if (innerLink) {
        borrowClasses(link, innerLink);
      } else {
        link.classList.add('jjb-back-link--nav-fallback');
      }
      li.appendChild(link);
      slot.container.insertBefore(li, slot.container.firstChild);
    } else {
      // Flat nav (<nav><a>...<a>...) — the template item is itself the link.
      borrowClasses(link, slot.template);
      slot.container.insertBefore(link, slot.container.firstChild);
    }
  }

  function injectFloating() {
    var link = makeLink();
    link.classList.add('jjb-back-link--floating');
    document.body.appendChild(link);
  }

  function run() {
    if (alreadyInjected() || !document.body) return;

    var nav = findNav();
    if (nav) {
      injectIntoNav(nav);
    } else {
      injectFloating();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run, { once: true });
  } else {
    run();
  }
})();
