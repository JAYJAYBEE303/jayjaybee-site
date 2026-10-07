// Shared race fixture for the self-checks (check.ts, check-design.ts).
export const T = Date.UTC(2024, 0, 1);
export const at = (s: number) => new Date(T + s * 1000).toISOString();
export const ms = (s: number) => T + s * 1000;
export const raceSession = {
  session_key: 9, session_name: 'Race', session_type: 'Race', date_start: at(0), date_end: at(3600),
  meeting_key: 1, circuit_key: 1, year: 2024, location: 'X',
};
export const lap = (d: number, n: number, start: number, dur: number | null, extra = {}) =>
  ({ driver_number: d, lap_number: n, date_start: at(start), lap_duration: dur, ...extra });
export const raceData = {
  drivers: [
    { driver_number: 1, name_acronym: 'VER', first_name: 'Max', last_name: 'Verstappen', team_name: 'Red Bull', team_colour: '3671C6' },
    { driver_number: 11, name_acronym: 'PER', team_name: 'Red Bull', team_colour: '3671C6' },
    { driver_number: 44, name_acronym: 'HAM', team_name: 'Mercedes', team_colour: 'bad' },
  ],
  laps: [
    lap(1, 1, 60, 95), lap(1, 2, 155, 90), lap(1, 3, 245, 91),
    lap(11, 1, 60, 96), lap(11, 2, 156, 91), lap(11, 3, 247, 90),
    lap(44, 1, 60, 97),
  ],
  position: [
    { driver_number: 1, date: at(60), position: 1 },
    { driver_number: 11, date: at(60), position: 2 },
    { driver_number: 44, date: at(60), position: 3 },
  ],
  stints: [
    { driver_number: 1, lap_start: 1, lap_end: 3, compound: 'SOFT', tyre_age_at_start: 0 },
    { driver_number: 11, lap_start: 1, lap_end: 2, compound: 'MEDIUM', tyre_age_at_start: 2 },
    { driver_number: 11, lap_start: 3, lap_end: 3, compound: 'HARD', tyre_age_at_start: 0 },
  ],
  intervals: [{ driver_number: 11, date: at(200), gap_to_leader: 1.234, interval: 1.234 }],
  raceControl: [
    { date: at(30), category: 'Flag', flag: 'GREEN', scope: 'Track', message: 'GREEN LIGHT' },
    { date: at(100), category: 'SafetyCar', message: 'SAFETY CAR DEPLOYED' },
    { date: at(150), category: 'SafetyCar', message: 'SAFETY CAR IN THIS LAP' },
    { date: at(330), category: 'Flag', flag: 'CHEQUERED', message: 'CHEQUERED FLAG' },
  ],
  weather: [{ date: at(0), air_temperature: 25, track_temperature: 40, humidity: 50, wind_speed: 1.2, rainfall: 0 }],
  pit: [{ driver_number: 11, date: at(240), pit_duration: 22 }],
};
