#!/usr/bin/env python3
"""
derive_constants.py — regenerate every model constant in the Understat channel
counters spec from live Understat data.

Source of truth for:
  * ROLE_SIGNATURE_THRESHOLDS      (js/config.js)
  * CHANNEL_AXIS_POOLED_SD         (js/config.js)
  * CHANNEL_WEIGHTS                (js/config.js, informed by the spread table)
  * every correlation quoted in docs/superpowers/specs/
      2026-08-20-understat-channel-counters-design.md

Run this to re-validate the constants against a newer season. It fetches
Understat's real internal JSON endpoints — the same ones api/fpl.js proxies —
and needs only the standard library plus network access.

    python derive_constants.py --season 2025 --out ./understat-cache

Constants in the spec were derived from season 2025 (the 2025/26 campaign,
complete) on 2026-08-20. Understat requires an explicit season on every path;
there is no "current season" default.
"""

import argparse
import gzip
import io
import json
import os
import statistics as st
import urllib.request

BASE = 'https://understat.com/'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36')

# Minimum evidence before a player's chain ratios are trusted. The published
# thresholds were derived at 900; js/config.js applies them in-season at 450
# (ROLE_SIGNATURE_MIN_MINUTES), which is the extrapolation the testing roadmap
# asks you to re-check mid-season.
MIN_MINUTES = 900
MIN_CHAIN = 0.5


# ── fetch ───────────────────────────────────────────────────────────────────

def fetch(path, referer_path):
    """GET one Understat internal JSON endpoint.

    Both headers matter: Understat gates these endpoints to same-page XHR
    traffic, and its bot detection has previously been sensitive to a missing
    Referer on direct requests. See api/fpl.js handleUnderstat().
    """
    req = urllib.request.Request(
        BASE + path,
        headers={
            'User-Agent': UA,
            'Accept': 'application/json',
            'Accept-Encoding': 'gzip',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': BASE + referer_path,
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read()
        if r.headers.get('Content-Encoding') == 'gzip':
            raw = gzip.decompress(raw)
    return json.loads(raw.decode('utf-8'))


def cached(cache_dir, name, fn):
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, name + '.json')
    if os.path.exists(path) and os.path.getsize(path) > 0:
        with io.open(path, encoding='utf-8') as f:
            return json.load(f)
    data = fn()
    with io.open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f)
    return data


# ── stats helpers ───────────────────────────────────────────────────────────

def corr(a, b):
    ma, mb = sum(a) / len(a), sum(b) / len(b)
    num = sum((x - ma) * (y - mb) for x, y in zip(a, b))
    den = (sum((x - ma) ** 2 for x in a) * sum((y - mb) ** 2 for y in b)) ** 0.5
    return num / den if den else float('nan')


def pct(v, k):
    v = sorted(v)
    return v[min(len(v) - 1, int(k * len(v)))]


# ── part 1: role signatures ─────────────────────────────────────────────────

def role_signatures(league):
    """buildupShare / createBias per player — mirrors buildRoleSignature()."""
    out = []
    for p in league['players']:
        minutes, chain = float(p['time']), float(p['xGChain'])
        if minutes < MIN_MINUTES or chain <= MIN_CHAIN:
            continue
        nineties = minutes / 90
        xa90 = float(p['xA']) / nineties
        npxg90 = float(p['npxG']) / nineties
        final = xa90 + npxg90
        out.append({
            'name': p['player_name'],
            'position': p['position'],
            'buildupShare': float(p['xGBuildup']) / chain,
            'createBias': xa90 / final if final > 0 else 0.5,
            'xa90': xa90,
            'npxg90': npxg90,
            'chain90': chain / nineties,
        })
    return out


def bucket(pos):
    """Approximate FPL element_type from Understat's coarse position string.

    Understat reports the SET of position groups a player has appeared in
    ('D M S' = defender, midfielder, substitute), not a single role. This is a
    proxy only — the engine uses real FPL element_type. Expect a handful of
    hybrids (Rice, Curtis Jones) to land in the wrong bucket here.
    """
    if pos.strip() in ('S', 'F S', 'F'):
        return 'FWD'
    s = set(pos.split())
    if 'GK' in s:
        return 'GK'
    if 'D' in s and 'F' not in s:
        return 'DEF'
    return 'MID'


def report_roles(players):
    print('=' * 72)
    print('PART 1 — ROLE SIGNATURE (feeds ROLE_SIGNATURE_THRESHOLDS)')
    print('=' * 72)
    for p in players:
        p['bucket'] = bucket(p['position'])

    print(f'\nn = {len(players)} players with >= {MIN_MINUTES} min\n')
    print(f'{"bucket":8s} {"n":>4s}  ' + '  '.join(f'{m:>18s}' for m in ('buildupShare', 'createBias', 'npxg90')))
    for b in ('DEF', 'MID', 'FWD'):
        g = [p for p in players if p['bucket'] == b]
        cells = []
        for m in ('buildupShare', 'createBias', 'npxg90'):
            v = [x[m] for x in g]
            cells.append(f'{pct(v,.25):.2f}/{pct(v,.5):.2f}/{pct(v,.75):.2f}'.rjust(18))
        print(f'{b:8s} {len(g):>4d}  ' + '  '.join(cells) + '   (p25/p50/p75)')

    # The two headline correlations are computed over PURE defenders — those
    # Understat never lists in midfield. Hybrids ('D M S': Rice, Zubimendi,
    # Curtis Jones) genuinely sit between the FB and CB clusters, so including
    # them measures a different question and blunts both figures
    # (-0.626 / -0.098 over all 139, versus the values below over 102).
    pure_defs = [p for p in players
                 if 'D' in p['position'].split() and 'M' not in p['position'].split()]
    print(f'\nThe two correlations the design rests on, across {len(pure_defs)} pure defenders:')
    print(f'  corr(buildupShare, xA/90)      = {corr([p["buildupShare"] for p in pure_defs], [p["xa90"] for p in pure_defs]):+.3f}'
          '   <- separates FB from CB')
    print(f'  corr(buildupShare, xGChain/90) = {corr([p["buildupShare"] for p in pure_defs], [p["chain90"] for p in pure_defs]):+.3f}'
          '   <- ~0 means the axis is quality-neutral')

    # Apply the published thresholds and eyeball the resulting groups.
    T = {'defFbBuildupShareMax': 0.82, 'defFbCreateBiasMin': 0.50,
         'midWmNpxg90Min': 0.22, 'midDmBuildupShareMin': 0.78,
         'fwdSsBuildupShareMin': 0.30}

    def classify(p):
        if p['bucket'] == 'DEF':
            return 'FB' if (p['buildupShare'] < T['defFbBuildupShareMax']
                            and p['createBias'] >= T['defFbCreateBiasMin']) else 'CB'
        if p['bucket'] == 'MID':
            if p['npxg90'] >= T['midWmNpxg90Min']:
                return 'WM'
            return 'DM' if p['buildupShare'] >= T['midDmBuildupShareMin'] else 'CM'
        if p['bucket'] == 'FWD':
            return 'SS' if p['buildupShare'] >= T['fwdSsBuildupShareMin'] else 'ST'
        return 'GKP'

    print('\nGroups produced by the published thresholds — sanity-check the names:')
    for role in ('FB', 'CB', 'WM', 'CM', 'DM', 'SS', 'ST'):
        g = sorted(p['name'] for p in players if classify(p) == role)
        print(f'  {role:3s} n={len(g):3d}  {", ".join(g[:7])}')


# ── part 2: channel axes ────────────────────────────────────────────────────

def axis_shares(stats):
    """Three axis shares per side — mirrors buildChannelProfile()."""
    sit, sz, asp = stats['situation'], stats['shotZone'], stats['attackSpeed']
    out = {}
    for side in ('for', 'against'):
        def xg(b):
            if not b:
                return 0.0
            return float(b['xG'] if side == 'for' else b['against']['xG'])
        # Penalties excluded: a penalty is a restart, not evidence of play style.
        dead = sum(xg(sit.get(k)) for k in ('FromCorner', 'SetPiece', 'DirectFreekick'))
        open_play = xg(sit.get('OpenPlay'))
        # Own goals excluded from the shot-zone denominator for the same reason.
        box = sum(xg(sz.get(k)) for k in ('shotSixYardBox', 'shotPenaltyArea'))
        obox = xg(sz.get('shotOboxTotal'))
        fast = xg(asp.get('Fast'))
        rest = sum(xg(asp.get(k)) for k in ('Normal', 'Standard', 'Slow'))
        out[side] = {
            'setPiece': dead / (dead + open_play) if dead + open_play else 0.0,
            'box': box / (box + obox) if box + obox else 0.0,
            'fast': fast / (fast + rest) if fast + rest else 0.0,
            'npxg': dead + open_play,
        }
    return out


def report_axes(rows):
    print('\n' + '=' * 72)
    print('PART 2 — CHANNEL AXES (feeds CHANNEL_AXIS_POOLED_SD, CHANNEL_WEIGHTS)')
    print('=' * 72)
    AX = ('setPiece', 'box', 'fast')
    slugs = list(rows)

    print(f'\nn = {len(slugs)} clubs\n')
    print(f'{"axis":10s} {"mean_for":>9s} {"sd_for":>8s} {"mean_agn":>9s} {"sd_agn":>8s} {"pooled_sd":>10s} {"|gap|":>8s}')
    pooled = {}
    for a in AX:
        f = [rows[s]['for'][a] for s in slugs]
        g = [rows[s]['against'][a] for s in slugs]
        sd_f, sd_g = st.pstdev(f), st.pstdev(g)
        pooled[a] = (sd_f ** 2 + sd_g ** 2) ** 0.5
        gap = abs(sum(f) / len(f) - sum(g) / len(g))
        print(f'{a:10s} {sum(f)/len(f):9.4f} {sd_f:8.4f} {sum(g)/len(g):9.4f} {sd_g:8.4f} '
              f'{pooled[a]:10.4f} {gap:8.5f}')

    print('\n|gap| is why no league constants are needed to centre the score: each')
    print('team\'s xG-for in an axis is another team\'s xG-against, so the league')
    print('baseline cancels out of (attackShare - concedeShare) automatically.')

    print('\nCHANNEL_AXIS_POOLED_SD (paste into js/config.js):')
    for key, a in (('setPieceThreat', 'setPiece'), ('wideTransition', 'fast'), ('boxThreat', 'box')):
        print(f'  {key:15s} {pooled[a]:.4f}')

    print('\nAxis independence — no axis should need collapsing into another:')
    for label, side in (('attacking', 'for'), ('defensive', 'against')):
        for i, a in enumerate(AX):
            for b in AX[i + 1:]:
                v = corr([rows[s][side][a] for s in slugs], [rows[s][side][b] for s in slugs])
                print(f'  {label:10s} corr({a}, {b}) = {v:+.3f}')

    print('\nResidual quality confound — shares are NOT perfectly quality-neutral:')
    vol_f = [rows[s]['for']['npxg'] for s in slugs]
    vol_a = [rows[s]['against']['npxg'] for s in slugs]
    for a in AX:
        print(f'  corr({a}_for, npxG_for)  = {corr([rows[s]["for"][a] for s in slugs], vol_f):+.3f}')
    for a in AX:
        print(f'  corr({a}_agn, npxGA)     = {corr([rows[s]["against"][a] for s in slugs], vol_a):+.3f}')
    print('\nCHANNEL_WEIGHTS leans away from the widest confound (box) and toward')
    print('the axis with the widest league spread and no existing signal (setPiece).')

    print('\nPer-club profile, sorted by set-piece reliance:')
    print(f'{"club":26s} {"SP_for":>7s} {"SP_agn":>7s} {"box_for":>8s} {"box_agn":>8s} {"fast_for":>9s} {"fast_agn":>9s}')
    for s in sorted(slugs, key=lambda s: -rows[s]['for']['setPiece']):
        r = rows[s]
        print(f'{s:26s} {r["for"]["setPiece"]:7.3f} {r["against"]["setPiece"]:7.3f} '
              f'{r["for"]["box"]:8.3f} {r["against"]["box"]:8.3f} '
              f'{r["for"]["fast"]:9.3f} {r["against"]["fast"]:9.3f}')


# ── main ────────────────────────────────────────────────────────────────────

def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--season', default='2025',
                    help='Understat season, e.g. 2025 for the 2025/26 campaign')
    ap.add_argument('--out', default='./understat-cache',
                    help='directory for cached payloads (re-run is offline)')
    args = ap.parse_args()

    league = cached(args.out, f'league-{args.season}',
                    lambda: fetch(f'getLeagueData/EPL/{args.season}',
                                  f'league/EPL/{args.season}'))

    report_roles(role_signatures(league))

    rows = {}
    for team in league['teams'].values():
        slug = team['title'].replace(' ', '_')
        payload = cached(args.out, f'team-{slug}-{args.season}',
                         lambda s=slug: fetch(f'getTeamData/{s}/{args.season}',
                                              f'team/{s}/{args.season}'))
        rows[slug] = axis_shares(payload['statistics'])

    report_axes(rows)


if __name__ == '__main__':
    main()
