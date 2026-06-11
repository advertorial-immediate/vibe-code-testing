# World Cup 2026 Predictions Pro

Run locally:

```bash
npm install
npm start
```

Keep your real API-Football key in `.env`:

```env
API_FOOTBALL_KEY=your_key_here
WORLD_CUP_LEAGUE_ID=1
WORLD_CUP_SEASON=2026
PORT=3000
```

This version keeps the key server-side only. The `/api/match-pack` endpoint now enriches each fixture with:

- API-Football prediction data when available
- a fallback score model based on each team's recent results and goals
- injury records by fixture and team
- published fixture lineups where available
- latest available previous lineups or squad-based estimated lineups as a fallback
