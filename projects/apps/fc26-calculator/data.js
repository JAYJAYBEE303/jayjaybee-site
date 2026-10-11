/* ═══════════════════════════════════════════════════════════════
   CONSOLE DATA — labels, groupings and reference profiles the views
   render. Presentation only: every number the views show comes from
   calculator.js (window.FC26). Keys here match the engine's keys.
   ═══════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const INPUT_GROUPS = [
    { key: 'move', title: 'Movement & dribbling', stats: [['baseAccel', 'Accel'], ['baseSprint', 'Sprint'], ['baseAgility', 'Agility'], ['balance', 'Balance'], ['dribbling', 'Dribbling'], ['ballControl', 'Ball control']] },
    { key: 'body', title: 'Physical profile', stats: [['heightCm', 'Height', 'cm', 150, 210], ['weight', 'Weight', 'kg', 50, 120], ['strength', 'Strength']] },
    { key: 'pass', title: 'Passing', stats: [['shortPass', 'Short pass'], ['longPass', 'Long pass'], ['vision', 'Vision'], ['crossing', 'Crossing'], ['curve', 'Curve'], ['fkAccuracy', 'FK accuracy']] },
    { key: 'def', title: 'Defending', stats: [['standTackle', 'Stand tackle'], ['slideTackle', 'Slide tackle'], ['interceptions', 'Interceptions'], ['defAwareness', 'Def. awareness']] },
    { key: 'shoot', title: 'Shooting', stats: [['finishing', 'Finishing'], ['shotPower', 'Shot power'], ['longShots', 'Long shots'], ['volleys', 'Volleys'], ['attPositioning', 'Att. positioning']] },
    { key: 'mental', title: 'Mental & physical', stats: [['composure', 'Composure'], ['reactions', 'Reactions'], ['stamina', 'Stamina'], ['jumping', 'Jumping'], ['headingAcc', 'Heading'], ['aggression', 'Aggression']] },
  ].map(g => ({ ...g, stats: g.stats.map(([id, label, unit, min, max]) => ({ id, label, unit: unit || '', min: min || 1, max: max || 99 })) }));
  const ALL_INPUTS = INPUT_GROUPS.flatMap(g => g.stats);
  
  const ACCEL_TYPES = [['explosive', 'Explosive'], ['controlled', 'Controlled'], ['lengthy', 'Lengthy']].map(([key, label]) => ({ key, label }));
  const BUILD_TYPES = [['very_lean', 'V. Lean'], ['lean', 'Lean'], ['normal', 'Average'], ['stocky', 'Stocky'], ['very_stocky', 'V. Stocky']].map(([key, label]) => ({ key, label }));
  const PS = [
    ['quickstep', 'quickstep_plus', 'Quickstep', 'Quickstep+', 'Pace', 'Accel +5', 'Accel +10 · Sprint +2', 'Quickstep.png', 'Quickstep Plus.png'],
    ['rapid', 'rapid_plus', 'Rapid', 'Rapid+', 'Pace', 'Accel +2 · Agility +2', 'Accel +5 · Agility +5', 'Rapid.png', 'Rapid Plus.png'],
    ['technical', 'technical_plus', 'Technical', 'Technical+', 'Dribbling', 'Agility +5', 'Agility +10', 'Technical.png', 'Technical plus.png'],
    ['first_touch', 'first_touch_plus', 'First Touch', 'First Touch+', 'Dribbling', 'Accel +2 · Slipperiness +2', 'Accel +5 · Slipperiness +5', 'First Touch.png', 'First Touch plus.png'],
    ['trickster', 'trickster_plus', 'Trickster', 'Trickster+', 'Dribbling', 'Agility +2', 'Agility +4', 'Trickster.png', 'Trickster Plus.png'],
    ['enforcer', 'enforcer_plus', 'Enforcer', 'Enforcer+', 'Physical', 'Tenacity +5', 'Tenacity +10', 'Enforcer.png', 'Enforcer plus.png'],
    ['bruiser', 'bruiser_plus', 'Bruiser', 'Bruiser+', 'Physical', 'Bully +6', 'Bully +12', 'Bruiser.png', 'Bruiser Plus.png'],
    ['press_proven', 'press_proven_plus', 'Press Proven', 'Press Proven+', 'Physical', 'Slipperiness +2 · Tenacity +2', 'Slipperiness +5 · Tenacity +5', 'Press Proven.png', 'Press Proven plus.png'],
    ['relentless', 'relentless_plus', 'Relentless', 'Relentless+', 'Physical', 'Cosmetic only', 'Cosmetic only', 'Relentless.png', 'Relentless Plus.png'],
    ['aerial', 'aerial_plus', 'Aerial', 'Aerial+', 'Physical', 'Aerial +10', 'Aerial +18', 'Aerial Fortress.png', 'Aerial Fortress Plus.png'],
    ['incisive', 'incisive_plus', 'Incisive Pass', 'Incisive Pass+', 'Passing', 'Through ball +8', 'Through ball +15', 'Incisive Pass.png', 'Incisive Pass plus.png'],
    ['pinged', 'pinged_plus', 'Pinged Pass', 'Pinged Pass+', 'Passing', 'Long pass +8', 'Long pass +15', 'Pinged Pass.png', 'Pinged Pass Plus.png'],
    ['long_ball', 'long_ball_plus', 'Long Ball Pass', 'Long Ball Pass+', 'Passing', 'Long pass +4 · Through +6', 'Long pass +10 · Through +12', 'Long Ball.png', 'Long Ball Plus.png'],
    ['whipped', 'whipped_plus', 'Whipped Pass', 'Whipped Pass+', 'Passing', 'Cross +8', 'Cross +20', 'Whipped Pass.png', 'Whipped Pass plus.png'],
    ['tiki_taka', 'tiki_taka_plus', 'Tiki Taka', 'Tiki Taka+', 'Passing', 'Short pass +5 · Through +2', 'Short pass +10 · Through +4', 'Tiki Taka.png', 'Tiki Taka Plus.png'],
    ['outside_foot', 'outside_foot_plus', 'Inventive', 'Inventive+', 'Passing', 'Finesse +3 · Through +3 · Low driven +3 · FK +1', 'Finesse +6 · Through +6 · Low driven +6 · FK +3', 'Inventive.png', 'Inventive Plus.png'],
    ['intercept_ps', 'intercept_ps_plus', 'Intercept', 'Intercept+', 'Defending', 'Interception +8', 'Interception +15', 'Intercept.png', 'Intercept Plus.png'],
    ['block', 'block_plus', 'Block', 'Block+', 'Defending', 'Positioning +6', 'Positioning +12', 'Block.png', 'Block plus.png'],
    ['jockey', 'jockey_plus', 'Jockey', 'Jockey+', 'Defending', 'Positioning +6', 'Positioning +12', 'Jockey.png', 'Jockey plus.png'],
    ['anticipate', 'anticipate_plus', 'Anticipate', 'Anticipate+', 'Defending', 'Tackle +8', 'Tackle +15', 'Anticipate.png', 'Anticipate plus.png'],
    ['slide_tackle_ps', 'slide_tackle_ps_plus', 'Slide Tackle', 'Slide Tackle+', 'Defending', 'Slide tackle +8', 'Slide tackle +15', 'Slide Tackle.png', 'Slide Tackle plus.png'],
    ['finesse', 'finesse_plus', 'Finesse Shot', 'Finesse Shot+', 'Shooting', 'Finesse +8', 'Finesse +15', 'Finess Shot.png', 'Finess Shot plus.png'],
    ['power_shot', 'power_shot_plus', 'Power Shot', 'Power Shot+', 'Shooting', 'Power +8', 'Power +15', 'powershot.png', 'powershot plus.png'],
    ['chip_shot', 'chip_shot_plus', 'Chip Shot', 'Chip Shot+', 'Shooting', 'Finishing +4', 'Finishing +8', 'chipshot.png', 'chipshot plus.png'],
    ['dead_ball', 'dead_ball_plus', 'Dead Shot', 'Dead Shot+', 'Shooting', 'Free kick +15', 'Free kick +28', 'Deadball.png', 'Deadball plus.png'],
    ['first_time', 'first_time_plus', 'Acrobatic', 'Acrobatic+', 'Shooting', 'Volley +10', 'Volley +18', 'Acrobatic.png', 'Acrobatic plus.png'],
    ['low_driven', 'low_driven_plus', 'Low Driven', 'Low Driven+', 'Shooting', 'Low driven +10', 'Low driven +18', 'Low Driven shot.png', 'Low Driven shot plus.png'],
    ['game_changer', 'game_changer_plus', 'Game Changer', 'Game Changer+', 'Shooting', 'Finishing +5 · Agility +2', 'Finishing +10 · Agility +4', 'Gamechanger (Flair).png', 'Gamechanger (Flair) plus.png'],
    ['precision_header', 'precision_header_plus', 'Precision Header', 'Precision Header+', 'Shooting', 'Aerial +8', 'Aerial +15', 'precisionheader.png', 'precisionheader plus.png'],
  ].map(([key, plus, name, plusName, cat, fx, fxPlus, icon, iconPlus]) => ({ key, plus, name, plusName, cat, fx, fxPlus, icon, iconPlus }));
  const PS_CATS = ['Pace', 'Dribbling', 'Physical', 'Passing', 'Defending', 'Shooting'];
  const CHEMS = [
    ['basic', 'Basic', 'Basic', '+3 to most stats'],
    ['hunter', 'Hunter', 'Attacking', 'Pace +6 · Volleys · Jumping'], ['hawk', 'Hawk', 'Attacking', 'Pace · Power · Aerial'], ['finisher', 'Finisher', 'Attacking', 'Finishing · Dribbling · Agility'],
    ['marksman', 'Marksman', 'Attacking', 'Long shots · Finishing · Strength'], ['deadeye', 'Deadeye', 'Attacking', 'Shot power · Passing'], ['sniper', 'Sniper', 'Attacking', 'Att. pos. · Strength · Stamina'],
    ['catalyst', 'Catalyst', 'Midfield', 'Pace +6 · Vision +9 · Passing'], ['engine', 'Engine', 'Midfield', 'Rounded creator profile'], ['artist', 'Artist', 'Midfield', 'Agility +9 · Curve +9'],
    ['architect', 'Architect', 'Midfield', 'Short pass +9 · Strength +9 · FK'], ['maestro', 'Maestro', 'Midfield', 'Long shots · FK · Passing'], ['powerhouse', 'Powerhouse', 'Midfield', 'Vision +9 · Tackle · Passing'],
    ['shadow', 'Shadow', 'Defending', 'Pace +6 · Slide tackle +9 · Aerial'], ['anchor', 'Anchor', 'Defending', 'Pace · Tackle · Strength · Aerial'], ['sentinel', 'Sentinel', 'Defending', 'Def. aware · Jumping · Heading'],
    ['guardian', 'Guardian', 'Defending', 'Tackle +9 · Dribbling · Agility'], ['gladiator', 'Gladiator', 'Defending', 'Shot power · Slide tackle · Reactions'], ['backbone', 'Backbone', 'Defending', 'Tackle · Long pass · Stamina · Aggression'],
  ].map(([key, name, group, fx]) => ({ key, name, group, fx }));
  const CHEM_GROUPS = ['Basic', 'Attacking', 'Midfield', 'Defending'];
  const ROLES = ['ST', 'CAM', 'Wing', 'CDM', 'FB', 'CB'];
  const ARCH_ATT = ['Assassin', 'Fighter', 'Bulldozer', 'Jungler', 'Freight Train'];
  const ARCH_DEF = ['Surgeon', 'Bruiser', 'Brawler', 'Spider', 'Wall'];
  
  const LAYERS = [
    { key: 'movement', title: 'Movement', stats: [['effA', 'Acceleration', 'ACC'], ['effS', 'Sprint speed', 'SPR'], ['effG', 'Agility', 'AGI'], ['effT', 'Tenacity', 'TEN'], ['effSlip', 'Slipperiness', 'SLP']] },
    { key: 'passing', title: 'Passing', stats: [['effPassShort', 'Short pass', 'SHT'], ['effPassLong', 'Long pass', 'LNG'], ['effPassThrough', 'Through ball', 'THR'], ['effPassCross', 'Cross', 'CRS']] },
    { key: 'defending', title: 'Defending', stats: [['effDefTackle', 'Tackle', 'TCK'], ['effDefPos', 'Positioning', 'POS'], ['effDefInt', 'Interception', 'INT'], ['effDefAer', 'Aerial', 'AER'], ['effDefBully', 'Bully', 'BLY'], ['effDefSlide', 'Slide tackle', 'SLD']] },
    { key: 'shooting', title: 'Shooting', stats: [['effShootFin', 'Finishing', 'FIN'], ['effShootPwr', 'Shot power', 'PWR'], ['effShootFine', 'Finesse', 'FNS'], ['effShootVol', 'Volley', 'VOL'], ['effShootLdr', 'Low driven', 'LDR'], ['effShootFk', 'Free kick', 'FK']] },
  ].map(l => ({ ...l, stats: l.stats.map(([k, label, short]) => ({ k, label, short })) }));
  const ALL_STATS = LAYERS.flatMap(l => l.stats.map(s => ({ ...s, layer: l.key })));
  const IDEALS = {
    'Assassin': ['attacker', 135, 110, 140, 70, 145, 105, 90, 110, 95, 70, 75, 75, 60, 60, 70, 110, 95, 115, 100, 100, 95],
    'Fighter': ['attacker', 130, 115, 130, 100, 130, 105, 95, 105, 100, 85, 85, 80, 70, 90, 80, 115, 110, 110, 105, 110, 100],
    'Bulldozer': ['attacker', 110, 100, 100, 130, 100, 100, 100, 95, 100, 95, 90, 90, 100, 130, 90, 120, 130, 100, 110, 120, 100],
    'Jungler': ['attacker', 125, 130, 115, 105, 115, 100, 105, 105, 105, 85, 85, 85, 115, 95, 90, 115, 115, 105, 110, 110, 100],
    'Freight Train': ['attacker', 115, 135, 95, 130, 100, 95, 105, 95, 100, 95, 90, 90, 130, 130, 95, 120, 130, 95, 115, 120, 95],
    'Surgeon': ['defender', 115, 105, 125, 105, 120, 115, 110, 105, 105, 130, 130, 130, 75, 90, 115, 85, 90, 95, 85, 90, 95],
    'Bruiser': ['defender', 105, 105, 105, 120, 105, 105, 105, 95, 100, 120, 120, 115, 110, 115, 115, 95, 105, 90, 90, 95, 90],
    'Brawler': ['defender', 100, 100, 100, 130, 95, 100, 100, 90, 95, 125, 115, 110, 110, 130, 115, 90, 110, 85, 95, 95, 85],
    'Spider': ['defender', 105, 115, 110, 105, 105, 105, 110, 95, 100, 120, 125, 120, 130, 110, 130, 90, 105, 90, 90, 95, 85],
    'Wall': ['defender', 90, 100, 90, 135, 90, 100, 105, 90, 95, 125, 120, 115, 140, 140, 110, 95, 115, 85, 95, 100, 85],
  };
  const idealFlat = name => { const a = IDEALS[name]; const o = {}; ALL_STATS.forEach((s, i) => o[s.k] = a[i + 1]); return o; };

  root.FC26_UI = {
    INPUT_GROUPS, ALL_INPUTS, ACCEL_TYPES, BUILD_TYPES, PS, PS_CATS, CHEMS, CHEM_GROUPS,
    ROLES, ARCH_ATT, ARCH_DEF, LAYERS, ALL_STATS, IDEALS, idealFlat,
    iconUrl: file => 'assets/' + encodeURI(file),
  };
})(window);
