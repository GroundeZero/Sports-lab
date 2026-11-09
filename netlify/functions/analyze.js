// Probabilities come ONLY from the simulations below. The AI (Gemini) supplies bounded context multipliers, never percentages.
const FB = 'https://v3.football.api-sports.io', BB = 'https://v1.basketball.api-sports.io';
const KEY = process.env.API_SPORTS_KEY;
const NOW = new Date(), Y = NOW.getFullYear(), M = NOW.getMonth();
const FBS = M >= 6 ? Y : Y - 1;
const S1 = M >= 6 ? `${Y}-${Y + 1}` : `${Y - 1}-${Y}`;
const S0 = M >= 6 ? `${Y - 1}-${Y}` : `${Y - 2}-${Y - 1}`;
const N = 20000;

const api = async (b, p) => { try { const r = await fetch(b + p, { headers: { 'x-apisports-key': KEY } }); return (await r.json()).response || []; } catch { return []; } };
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const sd = a => { if (a.length < 2) return 0; const m = avg(a); return Math.sqrt(avg(a.map(x => (x - m) ** 2))); };
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const shrink = (x, prior, n) => (x * n + prior * 6) / (n + 6);
const norm = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const pois = l => { if (l > 30) return Math.max(0, Math.round(l + Math.sqrt(l) * norm())); const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= Math.random(); } while (p > L); return k - 1; };
const disp = m => pois(Math.max(0.1, m * (1 + 0.2 * norm()))); // overdispersed counts (cards, shots)
const frac = (A, f) => { let c = 0; for (let i = 0; i < A.length; i++) if (f(A[i])) c++; return c / A.length; };
const lines = (m, s = 1) => { const b = Math.max(0.5, Math.floor(m) + 0.5); return [b - s, b, b + s].filter(l => l > 0); };

/* ---------- football ---------- */
async function fbTeam(name) {
  const t = (await api(FB, `/teams?search=${encodeURIComponent(name)}`))[0];
  if (!t) return null;
  const id = t.team.id;
  const [fx, next, inj] = await Promise.all([
    api(FB, `/fixtures?team=${id}&last=8`),
    api(FB, `/fixtures?team=${id}&next=3`),
    api(FB, `/injuries?team=${id}&season=${FBS}`)]);
  const done = fx.filter(f => f.goals.home != null);
  const gf = [], ga = [], form = [];
  done.forEach(f => { const h = f.teams.home.id === id; const a = h ? f.goals.home : f.goals.away, b = h ? f.goals.away : f.goals.home; gf.push(a); ga.push(b); form.push(a > b ? 'W' : a < b ? 'L' : 'D'); });
  const st = await Promise.all(done.slice(-5).map(f => api(FB, `/fixtures/statistics?fixture=${f.fixture.id}&team=${id}`)));
  const S = { shots: [], sot: [], cards: [], corners: [] };
  st.forEach(r => { const s = r[0] && r[0].statistics; if (!s) return; const g = k => Number((s.find(x => x.type === k) || {}).value) || 0; S.shots.push(g('Total Shots')); S.sot.push(g('Shots on Goal')); S.cards.push(g('Yellow Cards') + g('Red Cards')); S.corners.push(g('Corner Kicks')); });
  return {
    id, name: t.team.name, n: done.length, sn: S.cards.length, gf: avg(gf), ga: avg(ga), form: form.join(''),
    shots: avg(S.shots), sot: avg(S.sot), cards: avg(S.cards), corners: avg(S.corners),
    next: next.map(f => ({ date: f.fixture.date.slice(0, 10), comp: f.league.name, vs: f.teams.home.id === id ? f.teams.away.name : f.teams.home.name })),
    injuries: inj.sort((a, b) => b.fixture.date.localeCompare(a.fixture.date)).slice(0, 10).map(i => `${i.player.name} (${i.player.reason})`)
  };
}

function simFb(h, a, adj) {
  const n = Math.min(h.n, a.n);
  const lh = clamp(shrink((h.gf + a.ga) / 2, 1.4, n) * 1.08 * adj.home_mult, 0.2, 4.5);
  const la = clamp(shrink((a.gf + h.ga) / 2, 1.2, n) * adj.away_mult, 0.2, 4.5);
  const I = adj.intensity;
  const mC = (h.cards + a.cards) * I, mS = (h.shots + a.shots) * I, mT = (h.sot + a.sot) * I, mK = (h.corners + a.corners) * I;
  const G = [], C = [], S = [], T = [], K = []; let hw = 0, d = 0, aw = 0, bt = 0;
  for (let i = 0; i < N; i++) {
    const x = pois(lh), y = pois(la);
    G.push(x + y); x > y ? hw++ : x < y ? aw++ : d++; if (x > 0 && y > 0) bt++;
    C.push(disp(mC)); S.push(disp(mS)); T.push(disp(mT)); K.push(disp(mK));
  }
  const out = [], add = (g, l, p, u) => out.push({ g, l, p, u });
  add('Result', `${h.name} win`, hw / N); add('Result', 'Draw', d / N); add('Result', `${a.name} win`, aw / N);
  add('Double chance', `${h.name} or draw`, (hw + d) / N); add('Double chance', `${a.name} or draw`, (aw + d) / N); add('Double chance', 'Either team wins', (hw + aw) / N);
  add('Goals', 'Both teams score', bt / N, 1 - bt / N);
  [1.5, 2.5, 3.5].forEach(l => { const p = frac(G, v => v > l); add('Goals', `Over ${l}`, p, 1 - p); });
  [[C, mC, 1, 'Cards'], [S, mS, 2, 'Total shots'], [T, mT, 1, 'Shots on target'], [K, mK, 1, 'Corners']].forEach(([A, m, s, g]) => lines(m, s).forEach(l => { const p = frac(A, v => v > l); add(g, `Over ${l}`, p, 1 - p); }));
  return { out, exp: { [h.name + ' goals']: +lh.toFixed(2), [a.name + ' goals']: +la.toFixed(2) } };
}

/* ---------- basketball ---------- */
async function bbTeam(name) {
  const t = (await api(BB, `/teams?search=${encodeURIComponent(name)}`))[0];
  if (!t) return null;
  const id = t.id;
  const [c, p] = await Promise.all([api(BB, `/games?team=${id}&season=${S1}`), api(BB, `/games?team=${id}&season=${S0}`)]);
  const all = [...p, ...c].sort((x, y) => x.date.localeCompare(y.date));
  const done = all.filter(g => ['FT', 'AOT'].includes(g.status.short) && g.scores.home.quarter_4 != null).slice(-10);
  const own = [[], [], [], []], opp = [[], [], [], []], form = [];
  done.forEach(g => { const h = g.teams.home.id === id; const me = h ? g.scores.home : g.scores.away, ot = h ? g.scores.away : g.scores.home; for (let q = 0; q < 4; q++) { own[q].push(me['quarter_' + (q + 1)]); opp[q].push(ot['quarter_' + (q + 1)]); } form.push(me.total > ot.total ? 'W' : 'L'); });
  return {
    id, name: t.name, n: done.length, form: form.join(''), own: own.map(avg), ownSd: own.map(sd), opp: opp.map(avg),
    next: all.filter(g => g.status.short === 'NS').slice(0, 3).map(g => ({ date: g.date.slice(0, 10), comp: g.league.name, vs: g.teams.home.id === id ? g.teams.away.name : g.teams.home.name })), injuries: []
  };
}

function simBb(h, a, adj) {
  const fh = 1.02 * adj.home_mult * adj.intensity, fa = adj.away_mult * adj.intensity;
  const mu = (T, O, q, f) => (T.own[q] + O.opp[q]) / 2 * f;
  const s = (T, O, q) => Math.max(2.5, (T.ownSd[q] + O.ownSd[q]) / 2);
  const Q1 = [], H1 = [], H2 = [], F = [], HT = [], AT = []; let hw = 0;
  for (let i = 0; i < N; i++) {
    const hq = [], aq = [];
    for (let q = 0; q < 4; q++) { hq.push(mu(h, a, q, fh) + s(h, a, q) * norm()); aq.push(mu(a, h, q, fa) + s(a, h, q) * norm()); }
    const sum = (x, i0, i1) => x.slice(i0, i1).reduce((u, v) => u + v, 0);
    Q1.push(hq[0] + aq[0]); H1.push(sum(hq, 0, 2) + sum(aq, 0, 2)); H2.push(sum(hq, 2, 4) + sum(aq, 2, 4));
    HT.push(sum(hq, 0, 4)); AT.push(sum(aq, 0, 4)); F.push(HT[i] + AT[i]); if (HT[i] > AT[i]) hw++;
  }
  const mean = A => avg(A);
  const out = [], add = (g, l, p, u) => out.push({ g, l, p, u });
  add('Result', `${h.name} win`, hw / N); add('Result', `${a.name} win`, 1 - hw / N);
  [[Q1, 2, '1st quarter total'], [H1, 3, '1st half total'], [H2, 3, '2nd half total'], [F, 4, 'Game total (no OT)'], [HT, 4, `${h.name} team total`], [AT, 4, `${a.name} team total`]]
    .forEach(([A, st, g]) => lines(mean(A), st).forEach(l => { const p = frac(A, v => v > l); add(g, `Over ${l}`, p, 1 - p); }));
  return { out, exp: { [h.name]: +mean(HT).toFixed(1), [a.name]: +mean(AT).toFixed(1) } };
}

/* ---------- Claude: context only, bounded multipliers ---------- */
const SYS = `You are a sports context analyst. You NEVER output probabilities, odds or picks. Given recent form, upcoming fixtures, injuries, head-to-head and optional user-supplied team news, return ONLY JSON: {"home_mult":1,"away_mult":1,"intensity":1,"notes":["..."]}.
home_mult / away_mult scale that team's expected scoring (0.85 to 1.15): below 1 for missing key attackers or likely rotation before a bigger fixture, above 1 for opponent defensive absences. intensity (0.9 to 1.1) scales tempo and aggression: below 1 if both sides look likely to play conservatively, above 1 if both need an all-out result. notes: up to 5 short plain sentences explaining each adjustment. Use 1.0 when unsure. Never invent injuries or fixtures that are not in the input.`;

async function context(sport, h, a, h2h, news) {
  const neutral = { home_mult: 1, away_mult: 1, intensity: 1, notes: ['AI context unavailable, so neutral adjustments were used.'] };
  if (!process.env.GEMINI_API_KEY) return neutral;
  try {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYS }] },
        contents: [{ role: 'user', parts: [{ text: JSON.stringify({ today: NOW.toISOString().slice(0, 10), sport, home: h, away: a, h2h, user_news: news || '' }) }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 1500 }
      })
    });
    const j = await r.json();
    const t = j.candidates[0].content.parts.map(p => p.text || '').join('');
    const o = JSON.parse(t.replace(/```json|```/g, '').trim());
    return { home_mult: clamp(+o.home_mult || 1, 0.85, 1.15), away_mult: clamp(+o.away_mult || 1, 0.85, 1.15), intensity: clamp(+o.intensity || 1, 0.9, 1.1), notes: (o.notes || []).slice(0, 5).map(String) };
  } catch { return neutral; }
}

/* ---------- handler ---------- */
exports.handler = async e => {
  const res = o => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) });
  try {
    const { sport, home, away, league, news } = JSON.parse(e.body || '{}');
    if (!home || !away) return res({ status: 'error', message: 'Enter both teams.' });
    if (!KEY) return res({ status: 'error', message: 'API_SPORTS_KEY is not set in Netlify.' });
    if (league === 'Other') return res({ status: 'insufficient', reasons: ['This league is not in the supported list, so there is not enough data for a prediction.'] });
    const fb = sport === 'football';
    const [h, a] = await Promise.all([(fb ? fbTeam : bbTeam)(home), (fb ? fbTeam : bbTeam)(away)]);
    const reasons = [];
    if (!h) reasons.push(`Team not found: ${home}`);
    if (!a) reasons.push(`Team not found: ${away}`);
    if (h && a) {
      const min = fb ? 6 : 8;
      if (h.n < min) reasons.push(`Only ${h.n} recent games found for ${h.name}.`);
      if (a.n < min) reasons.push(`Only ${a.n} recent games found for ${a.name}.`);
      if (fb && (h.sn < 3 || a.sn < 3)) reasons.push('Match statistics (cards, shots) are missing for these teams.');
    }
    if (reasons.length) return res({ status: 'insufficient', reasons });
    let h2h = [];
    if (fb) h2h = (await api(FB, `/fixtures/headtohead?h2h=${h.id}-${a.id}&last=5`)).map(f => `${f.fixture.date.slice(0, 10)} ${f.teams.home.name} ${f.goals.home}-${f.goals.away} ${f.teams.away.name}`);
    else h2h = (await api(BB, `/games?h2h=${h.id}-${a.id}`)).filter(g => g.scores.home.total != null).slice(-5).map(g => `${g.date.slice(0, 10)} ${g.teams.home.name} ${g.scores.home.total}-${g.scores.away.total} ${g.teams.away.name}`);
    const adj = await context(sport, h, a, h2h, news);
    const sim = (fb ? simFb : simBb)(h, a, adj);
    const brief = t => ({ name: t.name, form: t.form, games: t.n, next: t.next, injuries: t.injuries });
    return res({ status: 'ok', sport, home: brief(h), away: brief(a), h2h, adj, expected: sim.exp, markets: sim.out, sims: N });
  } catch (err) { return res({ status: 'error', message: 'Something went wrong: ' + err.message }); }
};
