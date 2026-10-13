// Build-time content model. Ported from the "Mockup 8 / Brief" prototype's
// logic class so every page renders the same strings it did: typo() and fix()
// are applied to exactly the fields the prototype applied them to.
import content from '../data/content.json';
import wiki from '../data/wiki.json';
import thesis from '../data/thesis.json';

export { content, wiki, thesis };

export const pad = n => String(n).padStart(2, '0');
export const typo = t => (t || '').replace(/ - /g, ' – ').replace(/'/g, '’').replace(/"([^"]*)"/g, '“$1”');
// The prototype's fix() also corrected spellings and trailing "..": those are fixed in content.json itself.
export const fix = s => (s || '').replace(/ - /g, ' – ');
const date = d => { const [y, m, dd] = (d || '').split('-'); return d ? +dd + ' ' + 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ')[m - 1] + ' ' + y : ''; };

export const wikiHref = (a, x) => '/projects/wiki/' + a + '/' + (x ? x + '/' : '');

// ---- Projects ----
export const projectData = [
  { slug: 'gaffer-iq', mono: 'G', name: 'Gaffer IQ', kind: 'Fantasy Premier League analysis',
    line: 'Fixture difficulty scored as a pairing, not a property of one team.',
    lede: 'A Fantasy Premier League tool that stops treating fixture difficulty as a property of a team, and starts treating it as a property of a pairing.',
    body: 'FPL’s official 1–5 difficulty rating is blunt. Gaffer IQ replaces it with a weighted composite of five sub-metrics, covering form, home and away splits, style clashes and position-based counter-matchups, scored against the opponent so a fixture’s two ratings always sum to 100.',
    insideLabel: 'Five views, one scoring engine', inside: ['Matchups', 'Fixtures', 'Ranker', 'Dashboard', 'Planner'],
    facts: [['Role', 'Design, engine, code'], ['Stack', 'Vanilla JS, ES modules'], ['Backend', 'One Vercel function'], ['Status', 'Live, iterating']],
    noteHead: 'How it’s built:', note: 'Every score comes from pure functions running in the browser. The only server code is a Vercel function that proxies the FPL API to get round its CORS restrictions.',
    app: '/projects/apps/gaffer-iq/', wiki: wikiHref('gaffer-iq') },
  { slug: 'fc26-calculator', mono: 'FC', name: 'FC26 Feel Calculator', kind: 'EA FC 26 player model',
    line: 'What a player actually feels like on the pitch, past the card numbers.',
    lede: 'The card says 87 pace. The player doesn’t feel like 87 pace. This works out the difference.',
    body: 'It models chemistry, PlayStyles and the curves the game runs under the hood. The formulas went through several rounds of tuning against in-game testing, and the interface was rebuilt in Tailwind once the maths stopped moving.',
    insideLabel: 'Two layouts', inside: ['Focused mobile read', 'Desktop comparison'],
    facts: [['Role', 'Design, formulas, code'], ['Stack', 'HTML, JS, Tailwind'], ['Size', '~2,500 lines, one file'], ['Status', 'Live, iterating']],
    noteHead: 'What it taught me:', note: 'More about state management in plain JavaScript than any framework tutorial has. It exists because I wanted the version of this calculator I couldn’t find.',
    app: '/projects/apps/fc26-calculator/', wiki: wikiHref('fc26-calculator') },
  { slug: 'f1live', mono: 'F1', name: 'F1 Live', kind: 'F1 race replay',
    line: 'Any race or sprint from 2023 on, replayed from the public OpenF1 API.',
    lede: 'Any F1 race or sprint from 2023 on, replayed in the browser at anything from 0.1× to 256×.',
    body: 'Cars move on the track map with DRS zones, and the track colour follows safety cars, VSCs and red flags. Insight tabs show telemetry, lap-time and position charts, sector times and tyre stints, limited to what has happened so far in the replay.',
    insideLabel: 'In the replay', inside: ['Track map', 'Leaderboard', 'Telemetry', 'Lap charts', 'Tyre stints', 'Standings'],
    facts: [['Role', 'Design, code'], ['Stack', 'Vite, React, TypeScript'], ['Data', 'OpenF1, no backend'], ['Status', 'Live']],
    noteHead: 'Where it came from:', note: 'A web port of the race view from f1-race-replay, an open-source desktop Python app. This version reads OpenF1 straight from the browser and caches sessions so races reopen instantly.',
    app: '/projects/apps/f1live/', wiki: null }
];

export const projects = projectData.map((p, i) => ({ ...p, n: pad(i + 1), to: 'projects:' + p.slug, wikiTo: p.wiki ? 'wiki:' + p.slug + '/' : '',
  href: '/projects/#' + p.slug, facts: p.facts.map(([k, v]) => ({ k, v })) }));

// ---- Roles ----
const meta = {
  'exp-amf1': { slug: 'amf1', img: '/assets/images/roles/amf1.jpg', bg: '#00665E', stack: ['Entra ID', 'Intune', 'Jamf', 'Exchange Online', 'PowerShell'] },
  'exp-partnership': { slug: 'partnership', img: '/assets/images/roles/partnership.png', bg: '#D21E26', stack: ['Microsoft 365', 'Fortinet', 'AD + GPO', 'ConfigMgr'] },
  'exp-redbull': { slug: 'redbull', img: '/assets/images/roles/redbull.jpg', bg: '#071A30', stack: ['Task sequences', 'Imaging', 'Hardware lifecycle'] },
  'exp-apple': { slug: 'apple', img: '/assets/images/roles/apple-glyph.png', bg: '#EDEDEA', stack: ['Diagnostics', 'Repairs', 'Escalations'] }
};
const lines = {
  'exp-amf1': 'First and second-line support for HR, Finance, and Commercial, plus Entra, Intune, and Jamf admin across the fleet.',
  'exp-partnership': 'Multi-site support for schools at an MSP: 2,000+ accounts, 800+ devices. Started on the tools, ended up running the team.',
  'exp-redbull': 'A fixed-term season of imaging, deploying, and decommissioning kit inside fixed calendar windows.',
  'exp-apple': 'Five years of diagnostics, repairs, and explaining what’s wrong without making anyone feel stupid for asking.'
};
const logos = { 'exp-amf1': '/assets/logos/amf1.jpg', 'exp-partnership': '/assets/logos/partnership.png', 'exp-redbull': '/assets/logos/redbull.jpg', 'exp-apple': '/assets/logos/apple-glyph.png' };
const segShort = { 'exp-apple': 'Apple', 'exp-redbull': 'Red Bull', 'exp-partnership': 'Partnership Ed.', 'exp-amf1': 'Aston Martin F1' };

export const cases = content.roles.map((r, i) => {
  const m = meta[r.id];
  const sections = [
    { label: 'Problem', text: fix(r.note) },
    { label: 'Process', points: r.groups[0].points },
    { label: 'Skills built', points: r.groups[1].points },
    { label: 'Outcome', points: r.groups[2].points, big: true }
  ].map((s, k) => ({ n: pad(k + 1), label: s.label, domId: 'cs-' + k, text: s.text || '', big: !!s.big,
    points: (s.points || []).map((t, pi) => ({ n: pad(pi + 1), t: fix(t) })) }));
  return { slug: m.slug, to: 'case:' + m.slug, idx: pad(i + 1), href: '/work/' + m.slug + '/',
    title: r.title + (r.titleSub ? ' ' + r.titleSub : ''), org: (r.org + r.tm + r.orgTail + (r.orgSub ? ' ' + r.orgSub : '')).trim(),
    orgShort: r.short, years: fix(r.when), role: r.title, tone: m.bg, img: m.img, stack: m.stack.join(', '), logo: logos[r.id], sections };
});

export const homeRoles = content.roles.map((r, i) => {
  const org = (r.org + r.tm + r.orgTail).trim();
  return { i, when: fix(r.when).replace('Present', 'now'), org, title: (r.title + ' ' + r.titleSub).trim(), line: lines[r.id] || fix(r.note),
    slug: cases[i].slug, to: cases[i].to, href: cases[i].href, aria: 'Read the ' + org + ' role', logo: logos[r.id], current: !!r.current };
});

const now = 2026.8;
export const segs = content.roles.map((r, i) => ({ r, i })).reverse().map(({ r, i }) => {
  const from = +r.from, to = r.current ? now : +r.to;
  return { i, label: segShort[r.id] || r.short, from: r.from, grow: (to - from).toFixed(2), current: !!r.current };
});

const narr = fix(content.narrative), hl = ['endpoint work done well', 'people who leave the conversation in a better mood than they started it'];
const ranges = hl.map(h => { const i = narr.indexOf(h); return [i, i + h.length]; });
let wpos = 0;
export const words = narr.split(' ').map(w => { const s = wpos; wpos += w.length + 1; return { t: w + ' ', hl: ranges.some(([a, b]) => s >= a && s < b) }; });

export const keeps = content.about.like.keeps.map(k => ({ head: k.head.replace(/\.$/, ''), body: fix(k.body) }));

// ---- Wiki ----
const wIdx = {};
wiki.apps.forEach(a => { const f = a.sections[0]; wIdx[a.slug] = { href: wikiHref(a.slug, f.slug), title: a.title, lede: f.lede };
  // A draft section has no page; the prototype showed the app's front page for it.
  a.sections.forEach(s => { wIdx[s.slug] = { href: s.draft ? wikiHref(a.slug) : wikiHref(a.slug, s.slug), title: s.title, lede: s.lede }; }); });

// Inline markup: **bold**, `code`, [[slug|label]], [label](url), ((footnote)).
export function inl(str, notes) {
  const re = /\*\*(.+?)\*\*|`(.+?)`|\[\[([\w-]+)\|(.+?)\]\]|\[([^\]]+)\]\(([^)]+)\)|\(\((.+?)\)\)/g;
  const out = [];
  let last = 0, m;
  while ((m = re.exec(str))) {
    if (m.index > last) out.push({ k: 't', t: typo(str.slice(last, m.index)) });
    last = re.lastIndex;
    if (m[1]) out.push({ k: 'b', t: typo(m[1]) });
    else if (m[2]) out.push({ k: 'c', t: m[2] });
    else if (m[3]) { const tg = wIdx[m[3]]; out.push({ k: 'l', t: typo(m[4]), href: tg ? tg.href : '/projects/', title: tg ? tg.lede : '' }); }
    else if (m[5]) out.push({ k: 'l', t: m[5], href: m[6], ext: true });
    else if (m[7]) { notes.push(typo(m[7])); out.push({ k: 'f', n: notes.length }); }
  }
  if (last < str.length) out.push({ k: 't', t: typo(str.slice(last)) });
  return out;
}

const G = wiki.glossary, look = t => G[t.toLowerCase().trim()];
const flatW = x => typeof x === 'string' ? [x] : Array.isArray(x) ? x.flatMap(flatW) : Object.values(x).flatMap(flatW);
const mins = x => '~' + Math.max(1, Math.ceil(flatW(x.body).join(' ').replace(/\[\[[\w-]+\|/g, ' ').split(/\s+/).filter(w => /\w/.test(w)).length / 200)) + ' min';
const termOf = (t, skip) => { const d = look(t); if (!d) return null; const tg = d.r && d.r !== skip && wIdx[d.r];
  return { term: t, kind: d.k, text: typo(d.t), refHref: tg ? tg.href : '', refTitle: tg ? tg.title : '' }; };

// Route order the client transition engine needs (case cycling, wiki next/prev).
export const order = { roles: cases.map(c => c.slug), apps: Object.fromEntries(wiki.apps.map(a => [a.slug, a.sections.map(s => s.slug)])) };

function wikiBase(app) {
  const secs = app.sections;
  return { appSlug: app.slug, appTitle: app.title, contentsHref: wikiHref(app.slug), app: app.app, total: pad(secs.length),
    written: secs.filter(x => !x.draft).length, isDraftApp: !!app.draft };
}

export function wikiFront(app) {
  const secs = app.sections, live = secs.filter(x => !x.draft), proj = projectData.find(p => p.slug === app.slug) || { facts: [] };
  const groups = [...new Set(secs.map(x => x.group))].map(g => {
    const rows = secs.map((x, k) => ({ x, k })).filter(o => o.x.group === g).map(({ x, k }) => ({ slug: x.slug, to: 'wiki:' + app.slug + '/' + x.slug,
      isLink: !x.draft, n: pad(k + 1), title: x.title, lede: typo(x.lede), meta: mins(x), href: wikiHref(app.slug, x.slug) }));
    return { name: g, count: rows.length + (rows.length === 1 ? ' section' : ' sections'), rows };
  });
  const seen = new Set(), terms = [];
  [app.glance || []].concat(secs.map(x => x.glance || [])).forEach(gl => gl.forEach(([, ts]) => ts.forEach(t => {
    const k = t.toLowerCase().trim(); if (seen.has(k)) return; const o = termOf(t); if (o) { seen.add(k); terms.push(o); } })));
  const other = wiki.apps.find(a => a !== app), latest = secs.map(x => x.revised || app.revised).sort().pop();
  return { ...wikiBase(app), lede: typo(app.lede), revised: date(latest), startHref: wikiHref(app.slug, live[0].slug),
    facts: proj.facts.map(([k, v]) => ({ k, v })), summary: typo(app.summary).split(' ').map(t => t + ' '), groups, terms,
    other: other ? { slug: other.slug, to: 'wiki:' + other.slug + '/', href: wikiHref(other.slug), title: other.title, lede: typo(other.lede) } : null };
}

export function wikiSection(app, s) {
  const secs = app.sections, live = secs.filter(x => !x.draft), i = secs.indexOf(s), li = live.indexOf(s), notes = [];
  const toBlk = b => {
    if (typeof b === 'string') return { k: 'p', spans: inl(b, notes) };
    if (b.ul) return { k: 'ul', items: b.ul.map(t => { const m = t.match(/^\*\*(.+?)\*\*\s*[–-]\s*/);
      return m ? { lead: m[1], spans: inl(t.slice(m[0].length).replace(/^./, c => c.toUpperCase()), notes) } : { lead: '', spans: inl(t, notes) }; }) };
    if (b.ol) return { k: 'ol', items: b.ol.map((t, k) => ({ n: pad(k + 1), spans: inl(t, notes) })) };
    if (b.bands) return { k: 'bands', items: b.bands.map(([l, r]) => ({ l, r })) };
    return { k: '' };
  };
  let cur = { label: '', blocks: [] }; const chunks = [cur];
  s.body.forEach(b => { if (b && b.h) { cur = { label: typo(b.h), blocks: [] }; chunks.push(cur); } else cur.blocks.push(toBlk(b)); });
  const terms = (s.glance || []).flatMap(([, ts]) => ts).map(t => termOf(t, s.slug)).filter(Boolean);
  const all = wiki.apps.flatMap(a => a.sections.map(x => ({ a, x })));
  const needles = ['[[' + s.slug + '|'].concat(i === 0 ? ['[[' + app.slug + '|'] : []);
  const backs = all.filter(o => o.x !== s && !o.x.draft && needles.some(nd => JSON.stringify(o.x.body).includes(nd)))
    .map(o => ({ href: wikiHref(o.a.slug, o.x.slug), title: o.x.title, sub: o.a.title + ' · ' + o.x.group }));
  const prev = live[li - 1], nx = live[li + 1];
  return { ...wikiBase(app), slug: s.slug, n: pad(i + 1), title: s.title, group: s.group, lede: typo(s.lede), read: mins(s),
    revised: date(s.revised || app.revised), status: app.draft ? 'Draft' : 'Published',
    chunks: chunks.filter(c => c.blocks.length), terms, notes: notes.map((t, k) => ({ n: k + 1, t, id: 'wk-fn-' + (k + 1) })), backs,
    prev: prev ? { href: wikiHref(app.slug, prev.slug), title: prev.title } : null,
    nxt: nx ? { href: wikiHref(app.slug, nx.slug), title: nx.title } : null,
    next: nx ? { tx: 'wk-' + nx.slug, to: 'wiki:' + app.slug + '/' + nx.slug, label: 'Next in ' + app.title, title: nx.title, sub: nx.group, href: wikiHref(app.slug, nx.slug) }
      : { tx: '', to: '', label: 'End of the write-up', title: 'Back to contents', sub: app.title + ' · ' + live.length + ' sections', href: wikiHref(app.slug) } };
}

// ---- Thesis ----
export function buildThesis() {
  const T = thesis, C = T.chapters;
  const cap = s => s.replace(/^./, m => m.toUpperCase());
  const flat = x => typeof x === 'string' ? [x] : Array.isArray(x) ? x.flatMap(flat) : x && typeof x === 'object' ? Object.values(x).flatMap(flat) : [];
  const wc = x => flat(x).join(' ').split(/\s+/).filter(w => /\w/.test(w)).length;
  const scWords = wc(T.scenarios);
  const wordsN = C.map(c => wc(c.parts) + (c.parts.some(p => p.scenarios) ? scWords : 0));
  const min = n => '~' + Math.max(1, Math.round(n / 200)) + ' min';
  const part = p => {
    if (p.body) return { k: 'chunk', label: typo(p.h), paras: p.body.map(t => inl(t, [])) };
    if (p.strings) return { k: 'strings', items: p.strings.map(([t, x], k) => ({ n: pad(k + 1), t, x: cap(typo(x)) })) };
    if (p.pull) return { k: 'pull', words: typo(p.pull).split(' ').map(t => t + ' ') };
    if (p.scenarios) return { k: 'scen' };
    return { k: '' };
  };
  const chapters = C.map((c, i) => ({ i, id: c.id, num: c.num, title: typo(c.title), tags: c.tags, read: min(wordsN[i]), white: i % 2 === 0,
    parts: c.parts.map(part), next: C[i + 1] ? { num: C[i + 1].num, title: typo(C[i + 1].title), id: C[i + 1].id } : null }));
  const map = C.map((c, i) => ({ num: 'Chapter ' + c.num, title: typo(c.title), key: typo(c.key), read: min(wordsN[i]), id: c.id }));
  const segsT = C.map((c, i) => ({ grow: wordsN[i], label: 'Chapter ' + c.num + ': ' + typo(c.title), cur: 'Chapter ' + c.num + ' · ' + typo(c.title), id: c.id }));
  const all = T.scenarios.flatMap((c, a) => c.items.map((_, b) => a + '-' + b));
  const cats = T.scenarios.map((c, a) => ({ a, name: c.name, count: c.items.length,
    items: c.items.map((x, b) => {
      const sents = cap(typo(x[1])).split(/(?<=[.?!])\s+(?=[A-Z])/), outcome = sents.pop(), key = a + '-' + b;
      return { key, n: pad(b + 1), t: x[0], steps: sents, outcome, pos: (all.indexOf(key) + 1) + ' of ' + all.length };
    }) }));
  return { dek: typo(T.dek), subject: T.subject, revised: T.revised, read: min(wordsN.reduce((a, b) => a + b, 0)), map, chapters, segs: segsT, cats };
}
