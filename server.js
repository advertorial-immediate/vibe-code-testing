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
const SHORT_CACHE = 1000 * 60 * 5;        // 5 mins
const MEDIUM_CACHE = 1000 * 60 * 30;      // 30 mins
const LONG_CACHE = 1000 * 60 * 60 * 6;    // 6 hours
const DAY_CACHE = 1000 * 60 * 60 * 24;    // 24 hours

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
function strengthForTeam(teamOrName) {
  const name = typeof teamOrName === 'string' ? teamOrName : teamOrName?.name;
  return TEAM_STRENGTH[name] || 72;
}
function syntheticForm(teamOrName) {
  const r = strengthForTeam(teamOrName);
  if (r >= 88) return 'WWDWW';
  if (r >= 82) return 'WDWWD';
  if (r >= 78) return 'WDWDL';
  if (r >= 74) return 'DWLDW';
  return 'LDWDL';
}
function baseGoalProfile(teamOrName) {
  const r = strengthForTeam(teamOrName);
  return {
    scored: clamp(0.45 + (r / 100) * 1.45, 0.75, 2.25),
    conceded: clamp(2.25 - (r / 100) * 1.35, 0.65, 1.55),
    played: 0,
  };
}


function cacheKey(url) { return url.toString(); }
function getCached(url) {
  const row = cache.get(cacheKey(url));
  if (!row || row.expires < Date.now()) return null;
  return row.value;
}
function setCached(url, value, ttlMs = 1000 * 60 * 10) {
  cache.set(cacheKey(url), { value, expires: Date.now() + ttlMs });
}
function safeArray(value) { return Array.isArray(value) ? value : []; }
function todayISO() { return new Date().toISOString().slice(0, 10); }

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
  const gf = isHome ? hg : ag;
  const ga = isHome ? ag : hg;
  if (gf > ga) return 'W';
  if (gf < ga) return 'L';
  return 'D';
}
function formFromFixtures(fixtures, teamId, teamName) {
  const letters = safeArray(fixtures)
    .map(f => outcomeForTeam(f, teamId))
    .filter(Boolean)
    .slice(0, 5);
  return letters.length ? letters.join('') : syntheticForm(teamName);
}
function goalsForTeam(fixtures, teamId, teamName) {
  const rows = safeArray(fixtures).filter(f => f.goals?.home !== null && f.goals?.away !== null);
  if (!rows.length) return baseGoalProfile(teamName);
  let scored = 0, conceded = 0;
  for (const f of rows) {
    const isHome = f.teams?.home?.id === Number(teamId);
    scored += isHome ? Number(f.goals.home || 0) : Number(f.goals.away || 0);
    conceded += isHome ? Number(f.goals.away || 0) : Number(f.goals.home || 0);
  }
  return { scored: scored / rows.length, conceded: conceded / rows.length, played: rows.length };
}
function pointsFromForm(form) {
  return [...String(form || '')].reduce((sum, x) => sum + (x === 'W' ? 3 : x === 'D' ? 1 : 0), 0);
}
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function poissonishGoals(baseFor, oppAgainst, formPts, oppFormPts, homeBonus = 0) {
  const formAdj = (formPts - oppFormPts) * 0.035;
  return clamp((baseFor * 0.58) + (oppAgainst * 0.42) + formAdj + homeBonus, 0.25, 3.2);
}
function derivedPrediction(fixture, prediction, homeHistory, awayHistory, injuries) {
  const apiPred = prediction?.predictions;
  const homeId = fixture.teams.home.id;
  const awayId = fixture.teams.away.id;
  const homeName = fixture.teams.home.name;
  const awayName = fixture.teams.away.name;
  const homeForm = formFromFixtures(homeHistory, homeId, homeName);
  const awayForm = formFromFixtures(awayHistory, awayId, awayName);
  const hg = goalsForTeam(homeHistory, homeId, homeName);
  const ag = goalsForTeam(awayHistory, awayId, awayName);
  const hPts = pointsFromForm(homeForm);
  const aPts = pointsFromForm(awayForm);
  const hInj = safeArray(injuries).filter(i => i.team?.id === homeId).length;
  const aInj = safeArray(injuries).filter(i => i.team?.id === awayId).length;
  const ratingDiff = (strengthForTeam(homeName) - strengthForTeam(awayName)) / 100;

  let expectedHome;
  let expectedAway;
  if (apiPred?.goals?.home || apiPred?.goals?.away) {
    expectedHome = parseFloat(String(apiPred.goals.home).replace(/[^0-9.]/g, '')) || null;
    expectedAway = parseFloat(String(apiPred.goals.away).replace(/[^0-9.]/g, '')) || null;
  }
  if (!expectedHome || !expectedAway) {
    expectedHome = poissonishGoals(hg.scored, ag.conceded, hPts, aPts, 0.18 + ratingDiff * 0.7 - hInj * 0.08 + aInj * 0.06);
    expectedAway = poissonishGoals(ag.scored, hg.conceded, aPts, hPts, -ratingDiff * 0.7 - aInj * 0.08 + hInj * 0.06);
  }

  const homeGoals = clamp(Math.round(expectedHome), 0, 5);
  const awayGoals = clamp(Math.round(expectedAway), 0, 5);
  const rawHome = apiPred?.percent?.home ? parseInt(apiPred.percent.home, 10) : null;
  const rawDraw = apiPred?.percent?.draw ? parseInt(apiPred.percent.draw, 10) : null;
  const rawAway = apiPred?.percent?.away ? parseInt(apiPred.percent.away, 10) : null;
  let homePct = rawHome, drawPct = rawDraw, awayPct = rawAway;
  if (!homePct || !drawPct || !awayPct) {
    const diff = expectedHome - expectedAway;
    drawPct = clamp(Math.round(30 - Math.abs(diff) * 8), 16, 32);
    homePct = clamp(Math.round((100 - drawPct) / 2 + diff * 22), 8, 82);
    awayPct = 100 - drawPct - homePct;
  }
  return {
    score: { home: homeGoals, away: awayGoals },
    percent: { home: homePct, draw: drawPct, away: awayPct },
    expectedGoals: { home: Number(expectedHome.toFixed(2)), away: Number(expectedAway.toFixed(2)) },
    form: { home: homeForm, away: awayForm },
    source: apiPred ? 'API-Football plus local form model' : (hg.played || ag.played ? 'Recent results plus local model' : 'Strength-rating fallback until recent data is available'),
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
      ...sorted.filter(p => p.position === 'Attacker').slice(0, 3),
    ].slice(0, 11);
    if (picked.length) {
      return {
        team: { id: Number(teamId), name: teamName },
        formation: '4-3-3',
        startXI: picked.map((p, i) => ({ player: { id: p.id, name: p.name, number: p.number || i + 1, pos: p.position } })),
        estimated: true,
      };
    }
  } catch {}
  return null;
}

app.get('/api/config', async () => ({ leagueId: LEAGUE_ID, season: SEASON, hasKey: Boolean(API_KEY) }));
app.get('/api/fixtures', async (req) => {
  const { date, team, next, all } = req.query;
  const params = { league: LEAGUE_ID, season: SEASON };
  if (team) params.team = team;
  else if (next) params.next = next;
  else if (!all) params.date = date || todayISO();
  return apiFootball('fixtures', params, 1000 * 60 * 5);
});
app.get('/api/standings', async () => apiFootball('standings', { league: LEAGUE_ID, season: SEASON }, 1000 * 60 * 20));
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
app.get('/api/lineups', async (req) => apiFootball('fixtures/lineups', { fixture: req.query.fixture }, 1000 * 60 * 5));
app.get('/api/predictions', async (req) => apiFootball('predictions', { fixture: req.query.fixture }, 1000 * 60 * 30));
app.get('/api/teams', async () => apiFootball('teams', { league: LEAGUE_ID, season: SEASON }, 1000 * 60 * 60));
app.get('/api/squads', async (req) => apiFootball('players/squads', { team: req.query.team }, 1000 * 60 * 60 * 6));

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
  setCached(url, data, 1000 * 60 * 30);
  return data;
});

app.get('/api/match-pack', async (req) => {
  const fixtureId = req.query.fixture;
  const fixtureResult = await apiFootball('fixtures', { id: fixtureId }, 1000 * 60 * 10);
  const fixture = safeArray(fixtureResult.response)[0];
  if (!fixture) return { injuries: [], lineups: [], prediction: null, model: null, errors: ['Fixture not found'] };
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
]);

  const [fixtureInj, homeInj, awayInj, lineupsRaw, predRaw, homeHistRaw, awayHistRaw, homeLastLineup, awayLastLineup, homeSquad, awaySquad] = settled;
  const errors = settled.filter(x => x.status === 'rejected').map(x => x.reason?.message || String(x.reason));
  const injuries = [
    ...safeArray(fixtureInj.value?.response),
    ...safeArray(homeInj.value?.response),
    ...safeArray(awayInj.value?.response),
  ];
  const uniqueInjuries = Array.from(new Map(injuries.map(i => [`${i.team?.id}-${i.player?.id}-${i.reason}`, i])).values());
  let lineups = safeArray(lineupsRaw.value?.response);
  if (!lineups.length) lineups = [homeLastLineup.value, awayLastLineup.value].filter(Boolean);
  if (lineups.length < 2) {
    const existing = new Set(lineups.map(l => l.team?.id));
    if (!existing.has(homeId) && homeSquad.value) lineups.push(homeSquad.value);
    if (!existing.has(awayId) && awaySquad.value) lineups.push(awaySquad.value);
  }
  const prediction = safeArray(predRaw.value?.response)[0] || null;
  const homeHistory = safeArray(homeHistRaw.value?.response);
  const awayHistory = safeArray(awayHistRaw.value?.response);
  const model = derivedPrediction(fixture, prediction, homeHistory, awayHistory, uniqueInjuries);
  return {
    fixture,
    injuries: uniqueInjuries,
    lineups,
    prediction,
    model,
    history: { home: homeHistory, away: awayHistory },
    errors,
  };
});

app.setErrorHandler((error, req, reply) => {
  req.log.error(error);
  reply.status(500).send({ error: error.message });
});

app.listen({ port: Number(process.env.PORT || 3000), host: '0.0.0.0' });
