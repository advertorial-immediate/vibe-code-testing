import Fastify from 'fastify';
import cors from '@fastify/cors';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(import('@fastify/static'), {
  root: path.join(__dirname, 'public'),
  prefix: '/',
});

const API_KEY = process.env.API_FOOTBALL_KEY || '';
const API_BASE = 'https://v3.football.api-sports.io';
const LEAGUE_ID = Number(process.env.WORLD_CUP_LEAGUE_ID || 1);
const SEASON = Number(process.env.WORLD_CUP_SEASON || 2026);
const cache = new Map();
const SHORT_CACHE = 1000 * 60 * 5;
const MEDIUM_CACHE = 1000 * 60 * 30;
const LONG_CACHE = 1000 * 60 * 60 * 6;
const DAY_CACHE = 1000 * 60 * 60 * 24;

const TEAM_STRENGTH = {
  Argentina: 94, France: 94, Brazil: 92, Spain: 91, England: 90, Portugal: 89,
  Netherlands: 88, Belgium: 86, Germany: 86, Italy: 85, Uruguay: 84, Croatia: 84,
  Morocco: 83, Colombia: 83, Mexico: 82, USA: 81, Switzerland: 81, Denmark: 80,
  Japan: 80, Senegal: 79, Canada: 78, 'South Korea': 78, 'Korea Republic': 78,
  Australia: 76, Iran: 76, 'South Africa': 75, Qatar: 74, 'Czech Republic': 77,
  'Bosnia & Herzegovina': 74, Scotland: 74, Haiti: 68, Norway: 79, Sweden: 78,
  Poland: 78, Austria: 80, Chile: 76, Peru: 75, Tunisia: 74, Algeria: 76,
  Nigeria: 78, Ghana: 76, Ecuador: 78, 'Saudi Arabia': 74, Egypt: 77
};

function normaliseTeamName(name = '') {
  return String(name)
    .replace(/^United States$/i, 'USA')
    .replace(/^Korea Republic$/i, 'South Korea')
    .replace(/^Türkiye$/i, 'Turkey')
    .replace(/^IR Iran$/i, 'Iran')
    .trim();
}

// Keep this table easy to update from https://inside.fifa.com/fifa-world-ranking/men
// Values are ranking-style strength points, not exact live FIFA points for every team.
const FIFA_RANKING_POINTS = {
  France: 1880, Spain: 1875, Argentina: 1870, England: 1825, Brazil: 1775,
  Portugal: 1768, Netherlands: 1758, Belgium: 1742, Germany: 1736, Croatia: 1718,
  Italy: 1704, Morocco: 1698, Colombia: 1692, Uruguay: 1688, Mexico: 1680,
  USA: 1674, 'United States': 1674, Senegal: 1668, Japan: 1658, Switzerland: 1648,
  Denmark: 1638, Iran: 1624, Austria: 1618, 'South Korea': 1610, 'Korea Republic': 1610,
  Australia: 1585, Canada: 1578, Nigeria: 1572, Ecuador: 1568, Turkey: 1560, Türkiye: 1560,
  Norway: 1556, Poland: 1548, Sweden: 1538, Scotland: 1534, Algeria: 1528, Egypt: 1522,
  Tunisia: 1512, Ghana: 1504, Qatar: 1486, 'Saudi Arabia': 1478, 'South Africa': 1472,
  'Czech Republic': 1530, Czechia: 1530, 'Bosnia & Herzegovina': 1458, Haiti: 1335,
  Chile: 1518, Peru: 1514, Panama: 1494, 'Costa Rica': 1488, Jamaica: 1452,
  'New Zealand': 1425, Uzbekistan: 1498, Jordan: 1438
};

const HOST_TEAMS = new Set(['Mexico', 'USA', 'United States', 'Canada']);

const VENUE_COORDS = [
  { match: ['atlanta', 'mercedes-benz'], lat: 33.7554, lon: -84.4008 },
  { match: ['boston', 'foxborough', 'gillette'], lat: 42.0909, lon: -71.2643 },
  { match: ['dallas', 'arlington', 'at&t'], lat: 32.7473, lon: -97.0945 },
  { match: ['guadalajara', 'akron'], lat: 20.6819, lon: -103.4623 },
  { match: ['houston', 'nrg'], lat: 29.6847, lon: -95.4107 },
  { match: ['kansas city', 'arrowhead'], lat: 39.0489, lon: -94.4839 },
  { match: ['los angeles', 'inglewood', 'sofi'], lat: 33.9535, lon: -118.3392 },
  { match: ['mexico city', 'azteca'], lat: 19.3029, lon: -99.1505 },
  { match: ['miami', 'hard rock'], lat: 25.9580, lon: -80.2389 },
  { match: ['monterrey', 'bbva'], lat: 25.6682, lon: -100.2440 },
  { match: ['new york', 'new jersey', 'metlife', 'east rutherford'], lat: 40.8135, lon: -74.0745 },
  { match: ['philadelphia', 'lincoln financial'], lat: 39.9008, lon: -75.1675 },
  { match: ['san francisco', 'santa clara', 'levi'], lat: 37.4030, lon: -121.9700 },
  { match: ['seattle', 'lumen'], lat: 47.5952, lon: -122.3316 },
  { match: ['toronto', 'bmo'], lat: 43.6332, lon: -79.4186 },
  { match: ['vancouver', 'bc place'], lat: 49.2767, lon: -123.1119 }
];

function clamp(n, min, max) {
  const value = Number(n);
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function strengthForTeam(teamOrName) {
  const rawName = typeof teamOrName === 'string' ? teamOrName : teamOrName?.name;
  const name = normaliseTeamName(rawName);
  const local = TEAM_STRENGTH[name] || TEAM_STRENGTH[rawName] || 72;
  const fifa = FIFA_RANKING_POINTS[name] || FIFA_RANKING_POINTS[rawName] || 1400;
  const localScore = local / 100;
  const fifaScore = clamp((fifa - 1200) / 650, 0.45, 1.15);
  return clamp((localScore * 0.42) + (fifaScore * 0.58), 0.55, 1.2);
}

function syntheticForm(teamOrName) {
  const r = strengthForTeam(teamOrName);
  if (r >= 1.05) return 'WWDWW';
  if (r >= 0.95) return 'WDWWD';
  if (r >= 0.85) return 'WDWDL';
  if (r >= 0.75) return 'DWLDW';
  return 'LDWDL';
}

function baseGoalProfile(teamOrName) {
  const r = strengthForTeam(teamOrName);
  return {
    scored: clamp(0.65 + r * 1.25, 0.75, 2.35),
    conceded: clamp(2.05 - r * 0.95, 0.55, 1.65),
    played: 0
  };
}

function cacheKey(url) {
  return url.toString();
}

function getCached(url) {
  const row = cache.get(cacheKey(url));
  if (!row || row.expires < Date.now()) return null;
  return row.value;
}

function setCached(url, value, ttlMs = 1000 * 60 * 10) {
  cache.set(cacheKey(url), { value, expires: Date.now() + ttlMs });
}

async function apiFootball(endpoint, params = {}, ttlMs = 1000 * 60 * 10) {
  if (!API_KEY) throw new Error('Missing API_FOOTBALL_KEY. Add it to .env or your environment.');

  const url = new URL(`${API_BASE}/${endpoint}`);

  Object.entries(params).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  });

  const cached = getCached(url);
  if (cached) return cached;

  const response = await fetch(url, { headers: { 'x-apisports-key': API_KEY } });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API-Football ${response.status}: ${text.slice(0, 300)}`);
  }

  const data = await response.json();
  setCached(url, data, ttlMs);
  return data;
}

function outcomeForTeam(fixture, teamId) {
  const hg = fixture.goals?.home;
  const ag = fixture.goals?.away;

  if (hg === null || hg === undefined || ag === null || ag === undefined) return null;

  const isHome = fixture.teams?.home?.id === Number(teamId);
  const gf = isHome ? Number(hg) : Number(ag);
  const ga = isHome ? Number(ag) : Number(hg);

  if (gf > ga) return 'W';
  if (gf < ga) return 'L';
  return 'D';
}

function formFromFixtures(fixtures, teamId, teamName) {
  const letters = safeArray(fixtures)
    .filter(f => f.goals?.home !== null && f.goals?.away !== null)
    .map(f => outcomeForTeam(f, teamId))
    .filter(Boolean)
    .slice(0, 5);

  return letters.length ? letters.join('') : syntheticForm(teamName);
}

function goalsForTeam(fixtures, teamId, teamName) {
  const rows = safeArray(fixtures)
    .filter(f => f.goals?.home !== null && f.goals?.away !== null)
    .slice(0, 5);

  if (!rows.length) return baseGoalProfile(teamName);

  let scored = 0;
  let conceded = 0;

  for (const f of rows) {
    const isHome = f.teams?.home?.id === Number(teamId);
    scored += isHome ? Number(f.goals.home || 0) : Number(f.goals.away || 0);
    conceded += isHome ? Number(f.goals.away || 0) : Number(f.goals.home || 0);
  }

  return {
    scored: scored / rows.length,
    conceded: conceded / rows.length,
    played: rows.length
  };
}

function pointsFromForm(form) {
  return [...String(form || '')].reduce(
    (sum, x) => sum + (x === 'W' ? 3 : x === 'D' ? 1 : 0),
    0
  );
}

function parseApiExpectedGoal(value) {
  if (value === null || value === undefined) return null;
  const n = parseFloat(String(value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? clamp(n, 0.1, 4.5) : null;
}

function weatherProfile(teamName) {
  const name = normaliseTeamName(teamName);

  const warm = new Set([
    'Brazil', 'Argentina', 'Colombia', 'Ecuador', 'Mexico', 'USA', 'Uruguay', 'Paraguay',
    'Morocco', 'Senegal', 'Nigeria', 'Ghana', 'Cameroon', 'Tunisia', 'Algeria', 'Egypt',
    'Saudi Arabia', 'Qatar', 'Australia', 'Iran', 'Costa Rica', 'Panama', 'Jamaica'
  ]);

  const cold = new Set([
    'Canada', 'England', 'Scotland', 'Denmark', 'Sweden', 'Norway', 'Germany', 'Netherlands',
    'Belgium', 'Poland', 'Switzerland', 'Austria', 'Croatia', 'Czech Republic', 'Czechia'
  ]);

  const humid = new Set([
    'Brazil', 'Colombia', 'Ecuador', 'Japan', 'South Korea', 'Ghana', 'Nigeria', 'Cameroon',
    'Mexico', 'USA', 'Costa Rica', 'Panama'
  ]);

  return {
    warm: warm.has(name),
    cold: cold.has(name),
    humid: humid.has(name)
  };
}

function weatherAdjustment(teamName, weather = {}) {
  const temp = Number(
    weather.temperature ??
    weather.temp ??
    weather.temperature_2m ??
    weather.daily?.temperature_2m_max?.[0] ??
    21
  );

  const wind = Number(
    weather.windSpeed ??
    weather.wind_speed_10m ??
    weather.hourly?.wind_speed_10m?.[0] ??
    8
  );

  const rainProbability = Number(
    weather.precipitation_probability ??
    weather.daily?.precipitation_probability_max?.[0] ??
    weather.hourly?.precipitation_probability?.[0] ??
    0
  );

  const profile = weatherProfile(teamName);

  let familiarity = 0;
  let severity = 0;

  if (temp >= 28) {
    severity += 0.06;
    familiarity += profile.warm ? 0.04 : -0.05;
  }

  if (temp <= 8) {
    severity += 0.04;
    familiarity += profile.cold ? 0.03 : -0.04;
  }

  if (temp >= 24 && rainProbability >= 55) {
    severity += 0.04;
    familiarity += profile.humid ? 0.03 : -0.035;
  }

  if (wind >= 25) severity += 0.04;
  if (wind >= 38) severity += 0.08;
  if (rainProbability >= 65) severity += 0.04;
  if (rainProbability >= 85) severity += 0.07;

  return {
    temperature: Number.isFinite(temp) ? temp : null,
    windSpeed: Number.isFinite(wind) ? wind : null,
    rainProbability: Number.isFinite(rainProbability) ? rainProbability : null,
    familiarity: clamp(familiarity, -0.08, 0.06),
    severity: clamp(severity, 0, 0.2)
  };
}

function injuryPenalty(injuries, teamId) {
  const rows = safeArray(injuries).filter(i => i.team?.id === Number(teamId));
  return clamp(rows.length * 0.035, 0, 0.16);
}

const FIXTURE_VENUE_OVERRIDES = [
  {
    home: ['USA', 'United States'],
    away: ['Paraguay'],
    date: '2026-06-12',
    city: 'Los Angeles',
    venue: 'SoFi Stadium',
    lat: 33.9535,
    lon: -118.3392
  }
];

function fixtureOverrideVenue(fixture) {
  const home = normaliseTeamName(fixture?.teams?.home?.name || '');
  const away = normaliseTeamName(fixture?.teams?.away?.name || '');
  const date = String(fixture?.fixture?.date || '').slice(0, 10);

  return FIXTURE_VENUE_OVERRIDES.find(row => {
    const homeMatch = row.home.map(normaliseTeamName).includes(home);
    const awayMatch = row.away.map(normaliseTeamName).includes(away);
    return homeMatch && awayMatch && row.date === date;
  }) || null;
}

function fixtureVenueCoords(fixture) {
  const override = fixtureOverrideVenue(fixture);

  if (override) {
    return {
      city: override.city,
      venue: override.venue,
      lat: override.lat,
      lon: override.lon,
      source: 'fixture override'
    };
  }

  const haystack = `${fixture?.fixture?.venue?.name || ''} ${fixture?.fixture?.venue?.city || ''}`.toLowerCase();

  const matched = VENUE_COORDS.find(v =>
    v.match.some(term => haystack.includes(term))
  );

  if (!matched) return null;

  return {
    ...matched,
    source: 'venue text match'
  };
}

async function weatherForFixture(fixture) {
  const coords = fixtureVenueCoords(fixture);
  if (!coords) return null;

  const date = String(fixture?.fixture?.date || todayISO()).slice(0, 10);
  const url = new URL('https://api.open-meteo.com/v1/forecast');

  url.searchParams.set('latitude', String(coords.lat));
  url.searchParams.set('longitude', String(coords.lon));
  url.searchParams.set('hourly', 'temperature_2m,precipitation_probability,weather_code,wind_speed_10m');
  url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('start_date', date);
  url.searchParams.set('end_date', date);

  const cached = getCached(url);
  if (cached) return cached;

  const response = await fetch(url);
  if (!response.ok) return null;

  const data = await response.json();
  data.resolvedVenue = coords;
  data.resolvedCity = coords.city || fixture?.fixture?.venue?.city || null;
  data.resolvedVenueName = coords.venue || fixture?.fixture?.venue?.name || null;

  setCached(url, data, MEDIUM_CACHE);
  return data;
}

function teamModel({ teamName, teamId, opponentName, history, injuries, weather, isHome, apiXg }) {
  const strength = strengthForTeam(teamName);
  const opponentStrength = strengthForTeam(opponentName);
  const form = formFromFixtures(history, teamId, teamName);
  const formPts = pointsFromForm(form);
  const goalProfile = goalsForTeam(history, teamId, teamName);

  const formAdj = clamp((formPts - 6) * 0.035, -0.18, 0.22);
  const attackAdj = clamp((goalProfile.scored - 1.25) * 0.18, -0.16, 0.24);
  const defenceAdj = clamp((1.2 - goalProfile.conceded) * 0.14, -0.18, 0.18);
  const strengthAdj = clamp((strength - opponentStrength) * 0.9, -0.35, 0.35);
  const hostAdj = HOST_TEAMS.has(normaliseTeamName(teamName)) ? 0.12 : 0;
  const normalHomeAdj = isHome ? 0.08 : 0;
  const weatherAdj = weatherAdjustment(teamName, weather || {});
  const injAdj = injuryPenalty(injuries, teamId);

  const localXg = clamp(
    1.18 +
      strengthAdj +
      formAdj +
      attackAdj +
      defenceAdj +
      hostAdj +
      normalHomeAdj +
      weatherAdj.familiarity -
      weatherAdj.severity -
      injAdj,
    0.2,
    4.2
  );

  const blendedXg = apiXg
    ? clamp(localXg * 0.72 + apiXg * 0.28, 0.2, 4.2)
    : localXg;

  return {
    form,
    formPts,
    goalProfile,
    strength,
    localXg,
    apiXg,
    blendedXg,
    weather: weatherAdj,
    injuryPenalty: injAdj
  };
}

function predictionSeed(homeName, awayName, fixtureId) {
  const str = `${homeName}-${awayName}-${fixtureId || ''}`;
  let h = 0;

  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }

  return h;
}

function poissonProbability(lambda, k) {
  let factorial = 1;

  for (let i = 2; i <= k; i++) {
    factorial *= i;
  }

  return Math.exp(-lambda) * Math.pow(lambda, k) / factorial;
}

function scoreMatrix(homeXg, awayXg, seed) {
  const maxGoals = 6;
  const candidates = [];

  for (let h = 0; h <= maxGoals; h++) {
    for (let a = 0; a <= maxGoals; a++) {
      const p = poissonProbability(homeXg, h) * poissonProbability(awayXg, a);
      const upsetSpice = ((seed + h * 17 + a * 29) % 100) / 10000;
      candidates.push({ h, a, p: p + upsetSpice });
    }
  }

  candidates.sort((x, y) => y.p - x.p);

  const pickIndex = seed % Math.min(5, candidates.length);
  return candidates[pickIndex];
}

function derivedPrediction(fixture, prediction, homeHistory, awayHistory, injuries, weather = {}) {
  const apiPred = prediction?.predictions;

  const homeId = fixture.teams.home.id;
  const awayId = fixture.teams.away.id;
  const homeName = fixture.teams.home.name;
  const awayName = fixture.teams.away.name;

  const apiHomeXg = parseApiExpectedGoal(apiPred?.goals?.home);
  const apiAwayXg = parseApiExpectedGoal(apiPred?.goals?.away);

  const homeModel = teamModel({
    teamName: homeName,
    teamId: homeId,
    opponentName: awayName,
    history: homeHistory,
    injuries,
    weather,
    isHome: true,
    apiXg: apiHomeXg
  });

  const awayModel = teamModel({
    teamName: awayName,
    teamId: awayId,
    opponentName: homeName,
    history: awayHistory,
    injuries,
    weather,
    isHome: false,
    apiXg: apiAwayXg
  });

  const seed = predictionSeed(homeName, awayName, fixture.fixture?.id);
  const picked = scoreMatrix(homeModel.blendedXg, awayModel.blendedXg, seed);

  let homeGoals = picked.h;
  let awayGoals = picked.a;

  const diff = homeModel.blendedXg - awayModel.blendedXg;

  if (homeGoals === 2 && awayGoals === 1 && seed % 4 === 0) {
    homeGoals = diff > 0.65 ? 3 : 1;
  }

  if (homeGoals === 1 && awayGoals === 2 && seed % 4 === 1) {
    awayGoals = diff < -0.65 ? 3 : 1;
  }

  if (Math.abs(diff) > 1.15) {
    if (diff > 0 && homeGoals - awayGoals < 2) homeGoals += 1;
    if (diff < 0 && awayGoals - homeGoals < 2) awayGoals += 1;
  }

  homeGoals = clamp(homeGoals, 0, 6);
  awayGoals = clamp(awayGoals, 0, 6);

  const drawPct = clamp(Math.round(30 - Math.abs(diff) * 9), 14, 34);
  const homePct = clamp(Math.round((100 - drawPct) / 2 + diff * 24), 8, 82);
  const awayPct = 100 - drawPct - homePct;

  return {
    score: {
      home: homeGoals,
      away: awayGoals
    },
    percent: {
      home: homePct,
      draw: drawPct,
      away: awayPct
    },
    expectedGoals: {
      home: Number(homeModel.blendedXg.toFixed(2)),
      away: Number(awayModel.blendedXg.toFixed(2))
    },
    form: {
      home: homeModel.form,
      away: awayModel.form
    },
    source: apiPred
      ? 'Blended model: FIFA ranking, recent form, recent goals, injuries, host/weather factors and API-Football xG'
      : 'Local model: FIFA ranking, recent form, recent goals, injuries and host/weather factors',
    factors: {
      home: {
        strength: Number(homeModel.strength.toFixed(3)),
        localXg: Number(homeModel.localXg.toFixed(2)),
        apiXg: homeModel.apiXg,
        weather: homeModel.weather,
        injuryPenalty: homeModel.injuryPenalty
      },
      away: {
        strength: Number(awayModel.strength.toFixed(3)),
        localXg: Number(awayModel.localXg.toFixed(2)),
        apiXg: awayModel.apiXg,
        weather: awayModel.weather,
        injuryPenalty: awayModel.injuryPenalty
      }
    }
  };
}

async function latestLineupForTeam(teamId) {
  const fixtures = await apiFootball(
    'fixtures',
    { team: teamId, last: 8 },
    DAY_CACHE
  );

  for (const f of safeArray(fixtures.response)) {
    try {
      const lineup = await apiFootball(
        'fixtures/lineups',
        { fixture: f.fixture.id },
        DAY_CACHE
      );

      const row = safeArray(lineup.response).find(
        x => x.team?.id === Number(teamId)
      );

      if (row?.startXI?.length) {
        return {
          ...row,
          sourceFixture: f.fixture.id,
          sourceDate: f.fixture.date
        };
      }
    } catch {}
  }

  return null;
}

async function squadEstimate(teamId, teamName) {
  try {
    const squads = await apiFootball(
      'players/squads',
      { team: teamId },
      DAY_CACHE
    );

    const players = safeArray(safeArray(squads.response)[0]?.players);
    const order = { Goalkeeper: 1, Defender: 2, Midfielder: 3, Attacker: 4 };
    const sorted = players.sort((a, b) => (order[a.position] || 9) - (order[b.position] || 9));

    const picked = [
      ...sorted.filter(p => p.position === 'Goalkeeper').slice(0, 1),
      ...sorted.filter(p => p.position === 'Defender').slice(0, 4),
      ...sorted.filter(p => p.position === 'Midfielder').slice(0, 3),
      ...sorted.filter(p => p.position === 'Attacker').slice(0, 3)
    ].slice(0, 11);

    if (picked.length) {
      return {
        team: { id: Number(teamId), name: teamName },
        formation: '4-3-3',
        startXI: picked.map((p, i) => ({
          player: {
            id: p.id,
            name: p.name,
            number: p.number || i + 1,
            pos: p.position
          }
        })),
        estimated: true
      };
    }
  } catch {}

  return null;
}

app.get('/api/config', async () => ({
  leagueId: LEAGUE_ID,
  season: SEASON,
  hasKey: Boolean(API_KEY)
}));

app.get('/api/fixtures', async (req) => {
  const { date, team, next, all } = req.query;
  const params = { league: LEAGUE_ID, season: SEASON };

  if (team) params.team = team;
  else if (next) params.next = next;
  else if (!all) params.date = date || todayISO();

  return apiFootball('fixtures', params, SHORT_CACHE);
});

app.get('/api/standings', async () => {
  return apiFootball('standings', { league: LEAGUE_ID, season: SEASON }, 1000 * 60 * 20);
});

app.get('/api/injuries', async (req) => {
  const { fixture, team } = req.query;

  if (fixture) {
    return apiFootball('injuries', { fixture }, 1000 * 60 * 15);
  }

  if (team) {
    return apiFootball(
      'injuries',
      { team, league: LEAGUE_ID, season: SEASON },
      1000 * 60 * 30
    );
  }

  return { response: [] };
});

app.get('/api/lineups', async (req) => {
  return apiFootball('fixtures/lineups', { fixture: req.query.fixture }, SHORT_CACHE);
});

app.get('/api/predictions', async (req) => {
  return apiFootball('predictions', { fixture: req.query.fixture }, MEDIUM_CACHE);
});

app.get('/api/teams', async () => {
  return apiFootball('teams', { league: LEAGUE_ID, season: SEASON }, 1000 * 60 * 60);
});

app.get('/api/squads', async (req) => {
  return apiFootball('players/squads', { team: req.query.team }, LONG_CACHE);
});

app.get('/api/weather', async (req) => {
  const { lat, lon, date } = req.query;

  if (!lat || !lon) return { response: null };

  const url = new URL('https://api.open-meteo.com/v1/forecast');

  url.searchParams.set('latitude', String(lat));
  url.searchParams.set('longitude', String(lon));
  url.searchParams.set('hourly', 'temperature_2m,precipitation_probability,weather_code,wind_speed_10m');
  url.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');
  url.searchParams.set('timezone', 'auto');
  url.searchParams.set('start_date', String(date || todayISO()));
  url.searchParams.set('end_date', String(date || todayISO()));

  const cached = getCached(url);
  if (cached) return cached;

  const response = await fetch(url);
  const data = await response.json();

  setCached(url, data, MEDIUM_CACHE);
  return data;
});

app.get('/api/match-pack', async (req) => {
  const fixtureId = req.query.fixture;
  const fixtureResult = await apiFootball('fixtures', { id: fixtureId }, 1000 * 60 * 10);
  const fixture = safeArray(fixtureResult.response)[0];

  if (!fixture) {
    return {
      injuries: [],
      lineups: [],
      prediction: null,
      model: null,
      errors: ['Fixture not found']
    };
  }

  const homeId = fixture.teams.home.id;
  const awayId = fixture.teams.away.id;

  const settled = await Promise.allSettled([
    apiFootball(
      'injuries',
      { fixture: fixtureId },
      MEDIUM_CACHE
    ),

    apiFootball(
      'injuries',
      { team: homeId, league: LEAGUE_ID, season: SEASON },
      LONG_CACHE
    ),

    apiFootball(
      'injuries',
      { team: awayId, league: LEAGUE_ID, season: SEASON },
      LONG_CACHE
    ),

    apiFootball(
      'fixtures/lineups',
      { fixture: fixtureId },
      SHORT_CACHE
    ),

    apiFootball(
      'predictions',
      { fixture: fixtureId },
      MEDIUM_CACHE
    ),

    apiFootball(
      'fixtures',
      { team: homeId, last: 8 },
      DAY_CACHE
    ),

    apiFootball(
      'fixtures',
      { team: awayId, last: 8 },
      DAY_CACHE
    ),

    latestLineupForTeam(homeId),
    latestLineupForTeam(awayId),

    squadEstimate(homeId, fixture.teams.home.name),
    squadEstimate(awayId, fixture.teams.away.name),

    weatherForFixture(fixture)
  ]);

  const [
    fixtureInj,
    homeInj,
    awayInj,
    lineupsRaw,
    predRaw,
    homeHistRaw,
    awayHistRaw,
    homeLastLineup,
    awayLastLineup,
    homeSquad,
    awaySquad,
    weatherRaw
  ] = settled;

  const errors = settled
    .filter(x => x.status === 'rejected')
    .map(x => x.reason?.message || String(x.reason));

  const injuries = [
    ...safeArray(fixtureInj.value?.response),
    ...safeArray(homeInj.value?.response),
    ...safeArray(awayInj.value?.response)
  ];

  const uniqueInjuries = Array.from(
    new Map(injuries.map(i => [`${i.team?.id}-${i.player?.id}-${i.reason}`, i])).values()
  );

  let lineups = safeArray(lineupsRaw.value?.response);

  if (!lineups.length) {
    lineups = [homeLastLineup.value, awayLastLineup.value].filter(Boolean);
  }

  if (lineups.length < 2) {
    const existing = new Set(lineups.map(l => l.team?.id));

    if (!existing.has(homeId) && homeSquad.value) lineups.push(homeSquad.value);
    if (!existing.has(awayId) && awaySquad.value) lineups.push(awaySquad.value);
  }

  const prediction = safeArray(predRaw.value?.response)[0] || null;
  const homeHistory = safeArray(homeHistRaw.value?.response);
  const awayHistory = safeArray(awayHistRaw.value?.response);
  const weather = weatherRaw.status === 'fulfilled' ? weatherRaw.value : null;

  const model = derivedPrediction(
    fixture,
    prediction,
    homeHistory,
    awayHistory,
    uniqueInjuries,
    weather || {}
  );

  return {
    fixture,
    injuries: uniqueInjuries,
    lineups,
    prediction,
    model,
    weather,
    history: {
      home: homeHistory,
      away: awayHistory
    },
    errors
  };
});

app.setErrorHandler((error, req, reply) => {
  req.log.error(error);
  reply.status(500).send({ error: error.message });
});

app.listen({
  port: Number(process.env.PORT || 3000),
  host: '0.0.0.0'
});