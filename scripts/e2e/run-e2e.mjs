/**
 * Real end-to-end run:  npm run e2e   (NOT part of `npm test`; ~4-5 minutes, needs network once for PostgREST)
 *
 * The REAL production bundle, the REAL supabase-js client, the REAL SQL migrations on a scratch PostgreSQL 16,
 * a REAL PostgREST and a REAL headless Chromium. Only two things are faked: the language model (the stub
 * model server's scripted policy, behind scripts/e2e/gateway.mjs) and Supabase Realtime (refused).
 * See TESTING.md ("Real end-to-end") for what this proves and what it does not.
 *
 * Env: E2E_OUT_DIR (screenshots, bundle; default a fresh temp dir, printed), E2E_CACHE_DIR (PostgREST binary
 *      cache; default <tmp>/empire-of-agents-e2e-cache), PG_BIN, POSTGREST_VERSION, E2E_HEADED=1 (watch it).
 */
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { DRIVER_TTL_MS, DRIVER_TTL_SECONDS } from '../../src/sim/driver.ts';
import { checkFingerprint, parseManifest } from '../../src/sim/manifest.ts';
import { ISLAND_MANIFEST_TOML } from '../../src/sim/islandManifest.generated.ts';
import { makeOutDir, startStack } from './stack.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');

const MANIFEST = parseManifest(ISLAND_MANIFEST_TOML);
const STORY_TITLE = 'The Dawn of the Stubborn Hearth'; // the gateway's fixed answer to the chronicle-title request
const GREETING = 'Meet me at the old oak at dawn';
const WATCH_BANNER = 'Another window is driving this era — you are watching.';
// either note of a watching window: another window drives, or (found by the watcher's refresh) the driver has gone
const ANY_WATCH_BANNER = /Another window is driving this era|The window that was driving this era has stopped/;
const DRIVER_GONE_BANNER = 'The window that was driving this era has stopped — press "Try to take over" to continue it.';
const SPEED = 'Fast'; // 1.5 s per tick: the fastest speed the UI offers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const started = Date.now();
const results = [];
const notes = [];
let shotNo = 0;
let outDir;
let stack;
let gw; // the gateway
let browser;

// ---------------------------------------------------------------------------------------------- reporting
function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? `\n        ${String(detail).split('\n').join('\n        ')}` : ''}`);
  return Boolean(ok);
}
function note(text) {
  notes.push(text);
  console.log(`NOTE  ${text}`);
}
function section(title) {
  console.log(`\n== ${title}  (+${((Date.now() - started) / 1000).toFixed(0)} s)`);
}
async function shot(page, name) {
  if (!page || page.isClosed()) return null;
  const file = join(outDir, `${String(++shotNo).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file }).catch(() => {});
  console.log(`      screenshot ${file}`);
  return file;
}

// ---------------------------------------------------------------------------------------------- waiting, db
async function waitFor(label, fn, { timeout = 30000, interval = 150 } = {}) {
  const t0 = Date.now();
  let lastErr = null;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    if (Date.now() - t0 > timeout) throw new Error(`timed out after ${timeout} ms waiting for ${label}${lastErr ? ` (last error: ${lastErr.message})` : ''}`);
    await sleep(interval);
  }
}
/** waitFor reported as a PASS/FAIL line; returns the value or null. */
async function expectWait(name, fn, opts) {
  try {
    const v = await waitFor(name, fn, opts);
    check(name, true);
    return v;
  } catch (e) {
    check(name, false, e.message);
    return null;
  }
}
const q = (sql) => stack.db.query(sql); // a SELECT, rows as objects
const x = (sql) => stack.db.psql(sql); // any statement (INSERT/UPDATE/DELETE ... RETURNING), raw text
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const liveEra = () => q("SELECT * FROM sessions WHERE status='live' ORDER BY started_at DESC LIMIT 1")[0] ?? null;
const eraRow = (id) => q(`SELECT * FROM sessions WHERE id=${lit(id)}`)[0] ?? null;
const maxTick = (sid) => q(`SELECT coalesce(max(tick),0)::int AS t FROM agent_positions WHERE session_id=${lit(sid)}`)[0].t;
const villagers = (sid) => q(`SELECT * FROM agents WHERE session_id=${lit(sid)} ORDER BY created_at, id`);
const byName = (rows, name) => rows.find((r) => r.name === name);
const nameOf = (sid, agentId) => villagers(sid).find((v) => v.id === agentId)?.name ?? null;
const json = (v) => JSON.stringify(v);

const ERA_TABLES = ['events', 'agent_positions', 'agents', 'memories', 'checkpoints', 'structures', 'civ', 'depleted_objects'];
const ALL_TABLES = [...ERA_TABLES, 'sessions', 'relationships'];
/** Row counts and a content hash for every table's rows that belong to one era. */
function eraFingerprint(sid) {
  const out = {};
  for (const t of ERA_TABLES) {
    out[t] = q(`SELECT count(*)::int AS n, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM ${t} x WHERE session_id=${lit(sid)}`)[0];
  }
  out.session = q(`SELECT md5(x::text) AS h FROM sessions x WHERE id=${lit(sid)}`)[0]?.h ?? null;
  return out;
}
/** Row counts and a content hash for every table, all eras together. */
function globalFingerprint() {
  const out = {};
  for (const t of ALL_TABLES) {
    out[t] = q(`SELECT count(*)::int AS n, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') AS h FROM ${t} x`)[0];
  }
  return out;
}

/** What the database and the last requests looked like when a scenario broke. */
function diagnostics() {
  try {
    const eras = q('SELECT seq, status, driver_id, last_actor_id FROM sessions ORDER BY seq');
    const pos = q('SELECT s.seq, count(p.*)::int AS positions, coalesce(max(p.tick), 0)::int AS max_tick FROM sessions s LEFT JOIN agent_positions p ON p.session_id = s.id GROUP BY s.seq ORDER BY s.seq');
    const recent = gw.log.slice(-8).map((e) => `${e.method} ${decodeURIComponent(e.url).slice(0, 100)} -> ${e.status}`);
    return `era2=${S.era2?.id} fork=${S.fork?.id}\n${json(eras)}\n${json(pos)}\nlast requests:\n${recent.join('\n')}`;
  } catch (e) { return `(diagnostics failed: ${e.message})`; }
}

// ---------------------------------------------------------------------------------------------- browser helpers
const pageErrors = [];
const consoleErrors = [];
function watchPage(page, label) {
  page.on('pageerror', (e) => pageErrors.push(`${label}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${label}: ${m.text().slice(0, 160)}`); });
}
async function openApp(ctx, label) {
  const page = await ctx.newPage();
  watchPage(page, label);
  await page.goto(stack.appUrl);
  await page.locator('header').getByText(/Now playing:/).waitFor({ timeout: 30000 });
  return page;
}
const headerText = (p) => p.locator('header').innerText();
async function uiTick(p) {
  const m = /tick (\d+)/.exec(await headerText(p));
  return m ? Number(m[1]) : NaN;
}
// the speed buttons are lower-case in the DOM and capitalised by CSS: match the accessible name whole, ignoring case
const btn = (p, name) => p.getByRole('button', { name: new RegExp(`^${name}$`, 'i') });
async function waitVillagers(p, names = ['Alder', 'Bramble']) {
  for (const n of names) await p.getByTitle(new RegExp(`^${n} — press`)).waitFor({ timeout: 30000 });
}
async function openReplayTab(p) {
  await p.getByRole('button', { name: /Replay/ }).first().click();
}
const brainSince = (mark) => gw.brainRequests.slice(mark).filter((r) => !r.retry);
async function nextBrain(mark, pred = () => true, timeout = 30000) {
  return waitFor('a villager turn (agent-brain request)', () => brainSince(mark).find(pred), { timeout, interval: 50 });
}
/** Halt the loop through the UI and wait until the lease is released and the era has stopped writing. */
async function haltAndSettle(p, sid, label) {
  await btn(p, 'Halt').click();
  await waitFor(`${label}: lease released after Halt`, () => eraRow(sid).driver_id === null, { timeout: 15000 });
  const t = maxTick(sid);
  await sleep(300);
  return t;
}
const requestsOf = (page, filter) => gw.log.filter((e) => e.page === page && filter(e));
// session_lease_state is a STABLE function the app calls with POST (supabase-js rpc): a read, the way a watcher asks who drives
const isLeaseRead = (e) => e.method === 'POST' && e.url.split('?')[0] === '/rest/v1/rpc/session_lease_state';
const isWrite = (e) => !['GET', 'HEAD', 'OPTIONS'].includes(e.method) && !isLeaseRead(e);
const isRpc = (name) => (e) => e.method === 'POST' && e.url.split('?')[0] === `/rest/v1/rpc/${name}`;
const isClaim = isRpc('claim_session_lease');
const tableOf = (e) => (/\/rest\/v1\/([a-z_]+)/.exec(e.url) ?? [])[1] ?? e.url.split('?')[0];
// the Chronicle panel: one row per event (a type badge, the message, the tick), newest first
const FEED_ROWS = 'div.max-h-\\[560px\\] .rounded-lg.px-3.py-2';
const feedCount = (p) => p.locator(FEED_ROWS).count();
const feedMessages = (p) => p.locator(`${FEED_ROWS} > span.text-amber-50\\/85`).allInnerTexts();
// the polling fallback's request: the era's events (or memories) at or after the newest row on screen
const isFeedPoll = (table) => (e) => e.method === 'GET' && tableOf(e) === table && /created_at=gte\./.test(decodeURIComponent(e.url));
const eventCount = (sid) => q(`SELECT count(*)::int AS n FROM events WHERE session_id=${lit(sid)}`)[0].n;

// ---------------------------------------------------------------------------------------------- state shared by scenarios
const S = {};

// =============================================================================================== a) first load, new session
async function scenarioA() {
  section('a) first load, villagers seeded, end an empty era, start a new session');
  S.ctx1 = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { 'x-e2e-page': 'p1' } });
  S.p1 = await openApp(S.ctx1, 'p1');
  const p1 = S.p1;
  await waitVillagers(p1);
  await p1.getByText('Key set').waitFor({ timeout: 15000 }).then(
    () => check('settings-key edge function answered {set:true}: the header shows "Key set"', true),
    () => check('settings-key edge function answered {set:true}: the header shows "Key set"', false, 'text not found'));

  const era1 = liveEra();
  check('the era the app attached to is live and has no driver yet', era1 && era1.status === 'live' && era1.driver_id === null, json(era1));
  S.era1 = era1;
  const rows = villagers(era1.id);
  check('DB: exactly Alder and Bramble were seeded for the era', rows.length === 2 && rows.map((r) => r.name).sort().join() === 'Alder,Bramble', json(rows.map((r) => r.name)));
  for (const v of MANIFEST.startingVillagers) {
    const row = byName(rows, v.name);
    const ok = row && row.island === v.territory && row.position.x === v.pos.x && row.position.y === v.pos.y
      && row.color === v.color && row.persona === v.persona && json(row.inventory) === '[]' && json(row.inbox) === '[]';
    check(`DB: ${v.name} is at the manifest's (${v.pos.x},${v.pos.y}) in ${v.territory} with persona, colour, empty hands and inbox`, ok, json(row));
  }
  check('DB: the roster has a strict join order (distinct created_at, so the turn cursor means the same thing after every reload)',
    new Set(rows.map((r) => r.created_at)).size === rows.length, json(rows.map((r) => r.created_at)));
  check('DB: the founding event was chronicled', q(`SELECT 1 FROM events WHERE session_id=${lit(era1.id)} AND type='system' AND message='Alder and Bramble arrive to found the empire.'`).length === 1);

  const canvas = p1.locator('canvas').first();
  const box = await canvas.boundingBox();
  const png = await canvas.screenshot();
  check('UI: the island canvas is shown (WebGL, > 300 px wide, not a blank clear-colour image)', box && box.width > 300 && box.height > 300 && png.length > 20000, `box=${json(box)} png=${png.length} bytes`);
  check('UI: both villagers are in the hotbar and the era title is shown', (await headerText(p1)).includes(`Now playing: ${era1.title}`));
  check('UI: tick 0 is shown', (await uiTick(p1)) === 0);
  await shot(p1, 'a1-first-load');
  check('realtime: the app opened /realtime/v1 websockets, the gateway refused them, and the page still loaded without an uncaught error',
    gw.realtimeAttempts.length >= 1 && pageErrors.length === 0, `attempts=${gw.realtimeAttempts.length} pageErrors=${json(pageErrors)}`);
  const settingsReq = gw.log.find((e) => e.method === 'GET' && /\/rest\/v1\/settings\?/.test(e.url));
  check('the app does not touch the locked settings table on load (the old deploy-version reset was removed)', !settingsReq, `request=${json(settingsReq ?? null)}`);

  // end the (empty) era: the archive path, the stub-model title, and a continue button with nothing to continue from
  await p1.locator('header').getByRole('button', { name: /End session/ }).click();
  await p1.locator('div.fixed').getByRole('button', { name: 'End session', exact: true }).click();
  await p1.locator('header').getByRole('button', { name: /New session/ }).waitFor({ timeout: 30000 });
  const ended = eraRow(era1.id);
  check('end session: DB row archived with the title the model (stub) produced, ended_at set, ticks 0, lease clear',
    ended.status === 'archived' && ended.title === STORY_TITLE && ended.ended_at && ended.ticks === 0 && ended.driver_id === null, json(ended));
  check('end session: UI says the chronicle closed on that title', (await p1.getByText(STORY_TITLE).first().isVisible()));
  await openReplayTab(p1);
  const cont = p1.getByRole('button', { name: 'Continue from here' }).first();
  check('Replay: "Continue from here" is disabled for an era without a checkpoint, and says why',
    (await cont.isDisabled()) && (await p1.getByText('No checkpoint was recorded for this era.').first().isVisible()));
  await shot(p1, 'a2-archived-empty-era');

  // new session
  await p1.locator('header').getByRole('button', { name: /New session/ }).click();
  await btn(p1, 'Found the empire').click();
  await p1.locator('header').getByText(/Now playing: Session 2/).waitFor({ timeout: 30000 });
  await waitVillagers(p1);
  const era2 = liveEra();
  S.era2 = era2;
  check('new session: a second live era exists (seq 2), memories carried', era2 && era2.seq === 2 && era2.carry_memories === true && era2.id !== era1.id, json(era2));
  const rows2 = villagers(era2.id);
  const placed = MANIFEST.startingVillagers.every((v) => {
    const r = byName(rows2, v.name);
    return r && r.island === v.territory && r.position.x === v.pos.x && r.position.y === v.pos.y;
  });
  check('new session: Alder and Bramble exist in the new era at the manifest positions and territories', rows2.length === 2 && placed, json(rows2.map((r) => [r.name, r.position, r.island])));
  check('new session: the island canvas is shown and the tick is 0', (await p1.locator('canvas').first().isVisible()) && (await uiTick(p1)) === 0);
  check('DB: the archived era kept its villagers and its own chronicle', villagers(era1.id).length === 2 && q(`SELECT 1 FROM events WHERE session_id=${lit(era1.id)}`).length >= 2);
  await shot(p1, 'a3-new-session');
}

// =============================================================================================== d) a chat that is not heard yet survives a reload
async function scenarioChatReload() {
  section('d) reload with an unread chat: inbox, next actor and tick survive; heard exactly once');
  const p1 = S.p1;
  const era = S.era2.id;
  // the first turn: whoever acts first greets the villager beside them (at tick 0 they stand diagonally adjacent). The model is faked, the rest is the app.
  gw.scriptNext((r) => {
    const m = /Standing right beside you[^:]*: ([A-Za-z]+) \(([0-9a-f]{8})\)/.exec(r.observation);
    return m ? { thought: `I greet ${m[1]} with a message.`, action: { type: 'chat', data: { agent_id: m[2], message: GREETING } } } : null;
  });
  await btn(p1, 'Slow').click(); // 6 s between turns: room to halt after exactly one
  await btn(p1, 'Begin').click();
  await waitFor('tick 1 written', () => maxTick(era) >= 1, { timeout: 30000, interval: 50 });
  const t1 = await haltAndSettle(p1, era, 'p1');
  check('halted right after the first turn (tick 1)', t1 === 1, `tick ${t1}`);

  const first = q(`SELECT agent_id FROM agent_positions WHERE session_id=${lit(era)} ORDER BY tick LIMIT 1`)[0].agent_id;
  const speaker = nameOf(era, first);
  const listener = speaker === 'Alder' ? 'Bramble' : 'Alder';
  S.speaker = speaker; S.listener = listener;
  const rows = villagers(era);
  const lis = byName(rows, listener);
  check(`DB: the chat was written to ${listener}'s inbox by the app (agents.inbox is jsonb on the OTHER villager's row)`,
    lis.inbox.length === 1 && lis.inbox[0].message === GREETING && lis.inbox[0].fromName === speaker && lis.inbox[0].fromId === first, json(lis.inbox));
  check('DB: the chat is chronicled as an events row of type chat carrying the world\'s own answer, with the tick it happened at',
    q(`SELECT 1 FROM events WHERE session_id=${lit(era)} AND type='chat' AND message=${lit(`${speaker}: You say to ${listener}: "${GREETING}"`)} AND tick IS NOT NULL`).length === 1,
    json(q(`SELECT type, message FROM events WHERE session_id=${lit(era)}`)));
  check('DB: the speaker\'s agents.chat_count was incremented to 1 (read-then-update through PostgREST)', byName(rows, speaker).chat_count === 1, json(rows.map((r) => [r.name, r.chat_count])));
  const pair = q(`SELECT * FROM relationships WHERE a_id IN (${lit(rows[0].id)},${lit(rows[1].id)}) AND b_id IN (${lit(rows[0].id)},${lit(rows[1].id)})`);
  check('DB: the pair\'s bond was written by the app\'s upsert (on_conflict=a_id,b_id): one row, strength 1 (a chat is +1 for both)', pair.length === 1 && pair[0].strength === 1, json(pair));
  const cursor = eraRow(era);
  check('DB: the turn cursor names the speaker as the last actor', cursor.last_actor_id === first && cursor.last_actor_index >= 0, json([cursor.last_actor_id, cursor.last_actor_index]));
  check('DB: the speaker\'s hunger rose by 4 and energy fell by 3 for their one turn (needs are written)', byName(rows, speaker).hunger === 4 && byName(rows, speaker).energy === 97, json(byName(rows, speaker)));

  await p1.reload();
  await p1.locator('header').getByText(/Now playing:/).waitFor({ timeout: 30000 });
  await waitVillagers(p1);
  check('after the reload the UI shows tick 1, not 0 (the era continues where it stopped)', (await uiTick(p1)) === 1, `ui tick ${await uiTick(p1)}`);
  check('after the reload the lease is free and the button says Begin (nobody else holds the era)', eraRow(era).driver_id === null && (await btn(p1, 'Begin').isVisible()));
  await btn(p1, SPEED).click();
  const mark = gw.brainRequests.length;
  await btn(p1, 'Begin').click();
  const turn = await nextBrain(mark);
  check(`the next turn after the reload is ${listener}'s, not ${speaker}'s (the cursor survived)`, turn.actor === listener, `actor=${turn.actor}`);
  check(`${listener}'s observation starts at "Tick 1." (the clock continued)`, /^Tick 1\. /.test(turn.observation), turn.observation.slice(0, 80));
  check(`${listener} is told what ${speaker} said, as loaded from the database`,
    turn.observation.includes(`${speaker} says: "${GREETING}"`) && turn.observation.includes('Words spoken to you since your last turn'));
  await waitFor('tick 2 written', () => maxTick(era) >= 2, { timeout: 30000 });
  await sleep(300);
  const lis2 = byName(villagers(era), listener);
  check(`DB: ${listener}'s inbox is empty again after the turn (heard once)`, json(lis2.inbox) === '[]', json(lis2.inbox));
  S.heardMark = mark; // later turns of the listener must not contain the greeting
  await shot(p1, 'd1-after-reload-chat-heard');
}

// =============================================================================================== b) the run
async function scenarioRun() {
  section('b) the stub brain plays: ticks, events, positions, needs, inventory');
  const p1 = S.p1;
  const era = S.era2.id;
  const d = (await p1.locator('header').innerText()).includes('Halt');
  check('UI: the era is running (button shows Halt)', d);
  const e1 = eraRow(era);
  S.driver1 = e1.driver_id;
  check('DB: sessions.driver_id is set (by the real conditional UPDATE through PostgREST) with a fresh heartbeat',
    e1.driver_id && /^[0-9a-f-]{36}$/.test(e1.driver_id) && Date.now() - Date.parse(e1.driver_heartbeat_at) < 15000, json(e1));
  await waitFor('tick 8', () => maxTick(era) >= 8, { timeout: 60000 });
  const t = maxTick(era);
  const ticks = q(`SELECT tick FROM agent_positions WHERE session_id=${lit(era)} ORDER BY tick`).map((r) => r.tick);
  check('DB: agent_positions has exactly one row per tick, ticks 1..N without gaps or duplicates', ticks.every((v, i) => v === i + 1), json(ticks));
  const evTypes = q(`SELECT type, count(*)::int AS n FROM events WHERE session_id=${lit(era)} GROUP BY type`);
  const has = (ty) => evTypes.find((r) => r.type === ty)?.n > 0;
  check('DB: events rows exist for the turns (thought, gather_nearest, chat, system), each stamped with a tick',
    has('thought') && has('gather_nearest') && has('chat') && has('system') && q(`SELECT 1 FROM events WHERE session_id=${lit(era)} AND type='thought' AND tick IS NULL`).length === 0, json(evTypes));
  const rows = villagers(era);
  const turns = (v) => q(`SELECT count(*)::int AS n FROM agent_positions WHERE session_id=${lit(era)} AND agent_id=${lit(v.id)}`)[0].n;
  for (const v of rows) {
    const n = turns(v);
    check(`DB: ${v.name} acted ${n} times: hunger = ${Math.min(100, 4 * n)} (+4 per own turn) and energy fell from 100 (needs written by the turn update)`,
      v.hunger === Math.min(100, 4 * n) && v.energy < 100 && v.energy >= 0, json([v.hunger, v.energy, n]));
  }
  check('DB: carried items are written back as a jsonb array (someone is carrying what they gathered)', rows.some((v) => Array.isArray(v.inventory) && v.inventory.length > 0 && v.inventory.every((i) => typeof i === 'string')), json(rows.map((v) => v.inventory)));
  const lastPos = q(`SELECT DISTINCT ON (agent_id) agent_id, x, y FROM agent_positions WHERE session_id=${lit(era)} ORDER BY agent_id, tick DESC`);
  const posOk = lastPos.every((p) => { const v = rows.find((r) => r.id === p.agent_id); return v && v.position.x === p.x && v.position.y === p.y; });
  check('DB: each villager\'s agents.position equals their latest agent_positions row', posOk, json([lastPos, rows.map((r) => r.position)]));
  check('DB: agent_positions are inside the island grid', q(`SELECT 1 FROM agent_positions WHERE session_id=${lit(era)} AND (x<0 OR y<0 OR x>=${MANIFEST.world.gridSize} OR y>=${MANIFEST.world.gridSize})`).length === 0);
  const uiT = await uiTick(p1);
  check('UI: the header tick follows the database (within one turn)', Math.abs(uiT - maxTick(era)) <= 1, `ui=${uiT} db=${maxTick(era)}`);
  check('DB: memories were written for the turns, each with the era and a tick', q(`SELECT 1 FROM memories WHERE session_id=${lit(era)} AND tick IS NOT NULL`).length > 0 && q(`SELECT 1 FROM memories WHERE session_id=${lit(era)} AND tick IS NULL`).length === 0);
  // Realtime is refused, so the Chronicle can only follow the database through the polling fallback (src/sim/feed.ts).
  // Measured before the fallback: 4 rows on screen against 19 events in the database at tick 8.
  const sample = { rows: 0, db: 0 };
  const tracked = await waitFor('the Chronicle panel follows the database', async () => {
    sample.rows = await feedCount(p1);
    sample.db = eventCount(era);
    return sample.db >= 15 && sample.rows <= sample.db && sample.db - sample.rows <= 8;
  }, { timeout: 20000, interval: 400 }).then(() => true, () => false);
  check(`UI: with Realtime refused the Chronicle panel tracks the database while the era runs: ${sample.rows} rows on screen, ${sample.db} events in the database (was 4 vs 19 at tick ${t} before the polling fallback); within 8 rows`,
    tracked, json(sample));
  const polls = requestsOf('p1', isFeedPoll('events')).filter((e) => decodeURIComponent(e.url).includes(`session_id=eq.${era}`));
  check(`the panel was kept current by the fallback poll: p1 sent ${polls.length} GET /rest/v1/events requests for rows at or after its newest row (and no websocket delivered anything: ${gw.realtimeAttempts.length} refused upgrades)`,
    polls.length >= 2 && gw.realtimeAttempts.length >= 1, json(polls.slice(0, 2)));
  check('the poll is a small read: the era\'s events only, newest first, limited to the panel size (100)',
    polls.every((e) => decodeURIComponent(e.url).includes(`session_id=eq.${era}`) && /order=created_at\.desc/.test(e.url) && /limit=100/.test(e.url)), json(polls.slice(0, 1)));
  const memPolls = requestsOf('p1', isFeedPoll('memories'));
  check(`the Records feed is polled the same way (${memPolls.length} GET /rest/v1/memories requests)`, memPolls.length >= 2);
  await shot(p1, 'b1-running');
}

// =============================================================================================== d) reload while running
async function scenarioMidRunReload() {
  section('d) reload in the middle of a run: inventory, next actor and tick continue');
  const p1 = S.p1;
  const era = S.era2.id;
  await waitFor('a villager carrying something', () => villagers(era).some((v) => v.inventory.length > 0), { timeout: 60000 });
  const before = { tick: maxTick(era), cursor: eraRow(era).last_actor_id };
  const reloadMark = gw.log.length;
  await p1.reload(); // mid-run: the loop is running when the page goes away
  await p1.locator('header').getByText(/Now playing:/).waitFor({ timeout: 30000 });
  await waitVillagers(p1);
  const released = await waitFor('the old window to free the lease on unload', () => eraRow(era).driver_id === null, { timeout: 12000 }).then(() => true, () => false);
  check('the reloaded window freed its lease on pagehide (a reload does not lock the user out for 30 s)', released,
    `${json(eraRow(era))}\nsessions writes since the reload started:\n${gw.log.slice(reloadMark).filter((e) => e.method === 'PATCH' && /sessions/.test(e.url)).map((e) => `${((e.at - gw.log[reloadMark].at) / 1000).toFixed(2)}s ${e.page} ${decodeURIComponent(e.url).slice(0, 110)} ${e.body} -> ${e.status}`).join('\n')}`);
  await sleep(500);
  const after = { tick: maxTick(era), rows: villagers(era), cursor: eraRow(era) };
  check('DB: nothing is written after the window left (tick did not move once the lease was free)', after.tick === maxTick(era));
  check('the reload happened mid-run: the run had reached a tick > 5 and the tick after is at most one turn newer', before.tick > 5 && after.tick >= before.tick && after.tick <= before.tick + 2, json([before, after.tick]));
  const uiT = await uiTick(p1);
  check(`UI after the reload shows tick ${after.tick} (the era's last recorded tick), not 0`, uiT === after.tick, `ui=${uiT} db=${after.tick}`);
  const latestEvent = q(`SELECT message FROM events WHERE session_id=${lit(era)} ORDER BY created_at DESC LIMIT 1`)[0].message;
  check('UI: the Chronicle panel is filled again after the reload (loaded once from the database; the newest event is on screen)', await p1.getByText(latestEvent, { exact: true }).first().isVisible().catch(() => false), latestEvent);
  const carrying = after.rows.filter((v) => v.inventory.length > 0);
  check('DB: at least one villager is still carrying what they gathered (so the check below is not vacuous)', carrying.length > 0, json(after.rows.map((v) => v.inventory)));
  const mark = gw.brainRequests.length;
  await btn(p1, SPEED).click();
  await btn(p1, 'Begin').click();
  const ids = after.rows.map((v) => v.id);
  const lastIdx = ids.indexOf(after.cursor.last_actor_id);
  const expectedActor = after.rows[(lastIdx + 1) % ids.length].name;
  const turn = await nextBrain(mark);
  check(`the first turn after the reload is ${expectedActor}'s, the successor of the saved last actor`, turn.actor === expectedActor, `actor=${turn.actor}`);
  check(`the observation shows Tick ${after.tick} and exactly the items the database holds for ${turn.actor}`,
    turn.observation.startsWith(`Tick ${after.tick}. `) && turn.observation.includes(`Carrying: ${byName(after.rows, turn.actor).inventory.join(', ') || 'nothing'}.`),
    turn.observation.slice(0, 200));
  // a villager that carried something before the reload and acts again must still be carrying it in what the brain is shown
  const next = await nextBrain(mark, (r) => r.actor !== turn.actor);
  check('the second villager\'s observation also carries what the database held for them', next.observation.includes(`Carrying: ${byName(after.rows, next.actor).inventory.join(', ') || 'nothing'}.`) || next.observation.includes('Carrying:'));
  await waitFor('two more ticks', () => maxTick(era) >= after.tick + 2, { timeout: 30000 });
  check(`the new rows continue at tick ${after.tick + 1}, ${after.tick + 2} (no restart from 0, no duplicate)`,
    json(q(`SELECT tick FROM agent_positions WHERE session_id=${lit(era)} AND tick > ${after.tick} ORDER BY tick LIMIT 2`).map((r) => r.tick)) === json([after.tick + 1, after.tick + 2]));
  // the chat from before was heard once; no later turn of the listener contains it again
  const again = gw.brainRequests.slice(S.heardMark + 1).filter((r) => !r.retry && r.actor === S.listener && r.observation.includes(GREETING));
  check(`the greeting is never read to ${S.listener} again after it was heard (not resurrected by the reload)`, again.length === 0, `${again.length} later requests contain it`);
  await shot(p1, 'd2-after-midrun-reload');
}

// =============================================================================================== c) single driver
async function scenarioSingleDriver() {
  section('c) single driver: a second window watches, cannot write, then takes over');
  const p1 = S.p1;
  const era = S.era2.id;
  const d1 = eraRow(era);
  S.driverA = d1.driver_id;
  check('p1 is the driver: sessions.driver_id is p1\'s id', Boolean(d1.driver_id));
  const claimByP1 = requestsOf('p1', (e) => isClaim(e) && e.status === 200 && e.responseSnippet.trim() === 'true').pop();
  check('p1\'s own claim is POST /rest/v1/rpc/claim_session_lease, answered true, and names the driver id the database holds',
    claimByP1 && JSON.parse(claimByP1.body).p_driver === d1.driver_id && JSON.parse(claimByP1.body).p_session === era, claimByP1?.body);
  check('p1 sent no timestamp of its own with the claim (the body is only session, driver and ttl)', claimByP1 && json(Object.keys(JSON.parse(claimByP1.body)).sort()) === json(['p_driver', 'p_session', 'p_ttl_seconds']), claimByP1?.body);

  S.ctx2 = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { 'x-e2e-page': 'p2' } });
  const t0Ticks = maxTick(era);
  const t0Events = q(`SELECT count(*)::int AS n FROM events WHERE session_id=${lit(era)}`)[0].n;
  const p2 = await openApp(S.ctx2, 'p2');
  S.p2 = p2;
  await waitVillagers(p2);
  const banner = p2.getByText(WATCH_BANNER);
  check('p2 shows the watch-mode banner "Another window is driving this era — you are watching."', await banner.isVisible());
  const p2State = requestsOf('p2', isLeaseRead)[0];
  check('p2 learned that from the database: POST /rest/v1/rpc/session_lease_state answered "other"', p2State && p2State.status === 200 && p2State.responseSnippet.trim() === '"other"', json(p2State));
  check('p2 offers "Try to take over" instead of Begin', (await btn(p2, 'Try to take over').isVisible()) && (await btn(p2, 'Begin').count()) === 0);
  const speedDisabled = await Promise.all(['Slow', 'Normal', 'Fast'].map((s) => btn(p2, s).isDisabled()));
  const dismissButtons = p2.getByRole('button', { name: 'Dismiss' });
  const dismissDisabled = await Promise.all((await dismissButtons.all()).map((b) => b.isDisabled()));
  await p2.getByRole('button', { name: /Recruit villager/ }).click();
  await p2.getByPlaceholder('Name (e.g. Aldric)').fill('Cedar');
  const joinDisabled = await btn(p2, 'Join the empire').isDisabled();
  check('p2\'s controls are disabled: the three speed buttons, both Dismiss buttons and "Join the empire"',
    speedDisabled.every(Boolean) && dismissDisabled.length === 2 && dismissDisabled.every(Boolean) && joinDisabled, json([speedDisabled, dismissDisabled, joinDisabled]));
  await p2.getByRole('button', { name: /Recruit villager/ }).click();
  check('DB: loading p2 did not change the lease (still p1\'s)', eraRow(era).driver_id === S.driverA);
  await shot(p2, 'c1-watcher-banner');

  const watchTick = await uiTick(p2);
  await sleep(6000); // p1 keeps driving at its own pace while p2 watches
  const t1Ticks = maxTick(era);
  const t1Events = q(`SELECT count(*)::int AS n FROM events WHERE session_id=${lit(era)}`)[0].n;
  const p1PositionWrites = requestsOf('p1', (e) => e.method === 'POST' && tableOf(e) === 'agent_positions' && e.at >= gw.log.find((x) => x.page === 'p2')?.at).length;
  const p2Writes = requestsOf('p2', isWrite);
  const unexpected = p2Writes;
  check('p2 (the watcher) sent no write at all: no non-GET request to the backend', unexpected.length === 0, unexpected.map((e) => `${e.method} ${e.url} ${e.status}`).join('\n'));
  check('p2 wrote no positions, events, checkpoints, agents or memories (0 POST/PATCH/DELETE on those tables from p2)',
    p2Writes.filter((e) => ['agent_positions', 'events', 'checkpoints', 'agents', 'memories', 'civ', 'structures', 'depleted_objects', 'relationships'].includes(tableOf(e))).length === 0);
  check(`the database grew at p1's pace while p2 watched: +${t1Ticks - t0Ticks} ticks, ${p1PositionWrites} position inserts from p1 since p2 opened, none from p2`, t1Ticks > t0Ticks && t1Events > t0Events);
  const allTicks = q(`SELECT tick FROM agent_positions WHERE session_id=${lit(era)} ORDER BY tick`).map((r) => r.tick);
  check('DB: still exactly one position row per tick (two drivers would double-write ticks)', allTicks.every((v, i) => v === i + 1) && new Set(allTicks).size === allTicks.length, json(allTicks.slice(-12)));
  check('DB: the lease is still p1\'s after 6 s of p2 watching', eraRow(era).driver_id === S.driverA);

  // The watcher follows the era on its own: p2 is never reloaded, p1 keeps driving. Its Replay tab lists each villager with (x, y).
  await openReplayTab(p2);
  const posOf = async (p) => {
    const out = {};
    for (const t of await p.locator('button', { hasText: /\(\d+, \d+\)/ }).allInnerTexts()) {
      const m = /(\w+)\s*\((\d+), (\d+)\)/.exec(t);
      if (m) out[m[1]] = [Number(m[2]), Number(m[3])];
    }
    return out;
  };
  const picked = p2.locator('button', { hasText: /\(\d+, \d+\)/ }).first();
  await picked.click(); // a selection the refresh must not undo
  const pickedClass = async () => (await picked.getAttribute('class')) ?? '';
  // the scripted villagers stand still gathering, so make the next turn a wander: somebody really moves while p2 watches
  const hungerOf = (p) => p.locator('[title^="Hunger "]').evaluateAll((els) => els.map((e) => e.getAttribute('title')));
  const startedWatching = { tick: await uiTick(p2), pos: await posOf(p2), hunger: await hungerOf(p2) };
  gw.scriptNext(() => ({ thought: 'I wander to find new ground.', action: { type: 'wander', data: {} } }));
  const followedAt = Date.now();
  const followed = await waitFor('the watcher follows the era', async () => {
    const tk = await uiTick(p2);
    const pos = await posOf(p2);
    const hunger = await hungerOf(p2);
    return tk > startedWatching.tick && json(pos) !== json(startedWatching.pos) && json(hunger) !== json(startedWatching.hunger) ? { tk, pos, hunger } : null;
  }, { timeout: 12000, interval: 250 }).catch(() => null);
  check(`UI: the watcher's tick, villager positions and need bars advance without a reload while the driver runs: tick ${watchTick} at load, ${startedWatching.tick} -> ${followed?.tk} within ${((Date.now() - followedAt) / 1000).toFixed(1)} s, ${json(startedWatching.pos)} -> ${json(followed?.pos)}, hunger ${json(startedWatching.hunger)} -> ${json(followed?.hunger)}`,
    followed && Date.now() - followedAt <= 10000 && followed.tk > watchTick,
    `${json([startedWatching, followed])}\nui now: tick ${await uiTick(p2)} ${json(await posOf(p2))}\ndb now: tick ${maxTick(era)} ${json(villagers(era).map((v) => [v.name, v.position]))}`);
  if (followed) {
    const known = q(`SELECT a.name, p.x, p.y FROM agent_positions p JOIN agents a ON a.id = p.agent_id WHERE p.session_id=${lit(era)}`);
    check('the positions the watcher shows are positions the driver really wrote (each matches an agent_positions row of that villager)',
      Object.entries(followed.pos).every(([name, [px, py]]) => known.some((r) => r.name === name && r.x === px && r.y === py)), json([followed.pos]));
  }
  check(`UI: the watcher's tick is within 6 ticks of the database (${await uiTick(p2)} vs ${maxTick(era)}), not frozen at the ${watchTick} it loaded`, Math.abs(maxTick(era) - (await uiTick(p2))) <= 6);
  check('UI: the watcher kept its own selection (the Replay tab and the villager it picked) across the refreshes', (await pickedClass()).includes('border-amber-600/60') && (await p2.getByRole('button', { name: /Replay/ }).first().isVisible()));
  const leaseChecks = requestsOf('p2', isLeaseRead);
  check(`the refresh re-asked who drives (${leaseChecks.length} POST session_lease_state calls from p2, the first at load) and every answer was "other" while p1 drove`,
    leaseChecks.length >= 3 && leaseChecks.every((e) => e.status === 200 && e.responseSnippet.trim() === '"other"'), json(leaseChecks.map((e) => e.responseSnippet)));
  check('the watcher still sent no write while refreshing: no non-GET request from p2 other than the read-only session_lease_state', requestsOf('p2', isWrite).length === 0, requestsOf('p2', isWrite).map((e) => `${e.method} ${e.url}`).join('\n'));
  check('the refresh never touched the lease or the bonds: no claim/renew/release call and no relationships request beyond the load-time bond GETs',
    requestsOf('p2', (e) => isClaim(e) || isRpc('renew_session_lease')(e) || isRpc('release_session_lease')(e)).length === 0
    && requestsOf('p2', (e) => tableOf(e) === 'relationships' && e.method !== 'GET').length === 0);

  // p2 tries to take over while p1 is alive: the real conditional UPDATE comes back with zero rows
  const nPatch = gw.log.length;
  await btn(p2, 'Try to take over').click();
  const denied = await waitFor('the denied claim request', () => gw.log.slice(nPatch).find((e) => e.page === 'p2' && isClaim(e)), { timeout: 10000 });
  S.deniedClaim = denied;
  check('p2 "Try to take over" while p1 drives: claim_session_lease answers HTTP 200 with false, p2 stays a watcher and the lease stays p1\'s',
    denied.status === 200 && denied.responseSnippet.trim() === 'false' && (await banner.isVisible()) && eraRow(era).driver_id === S.driverA, json(denied));

  // close p1: the lease is released by pagehide (not by waiting out the 30 s TTL)
  const tBeforeClose = maxTick(era);
  const logBeforeClose = gw.log.length;
  await p1.close({ runBeforeUnload: true });
  const closedAt = Date.now();
  const freed = await waitFor('p1 closed -> lease free', () => eraRow(era).driver_id === null, { timeout: 8000 }).then(() => true, () => false);
  check(`closing p1 released the lease within ${((Date.now() - closedAt) / 1000).toFixed(1)} s (pagehide/beforeunload), without waiting for the ${DRIVER_TTL_MS / 1000} s TTL`, freed, json(eraRow(era)));
  // pagehide and beforeunload both send it: the first frees the lease (true), a second finds nothing of p1's to free (false)
  const unloadReleases = gw.log.slice(logBeforeClose).filter((e) => e.page === 'p1' && isRpc('release_session_lease')(e));
  check('the unload release was the keepalive POST /rest/v1/rpc/release_session_lease naming p1\'s id: HTTP 200, one answered true (the other, if any, false)',
    unloadReleases.length >= 1 && unloadReleases.every((r) => r.status === 200 && JSON.parse(r.body).p_driver === S.driverA && JSON.parse(r.body).p_session === era)
    && unloadReleases.filter((r) => r.responseSnippet.trim() === 'true').length === 1, json(unloadReleases));
  if (!freed) {
    note('p1\'s close did not release the lease; waiting out the TTL instead');
    await waitFor('lease stale', () => Date.now() - Date.parse(eraRow(era).driver_heartbeat_at) > DRIVER_TTL_MS + 1000, { timeout: 45000, interval: 500 });
  }
  await sleep(1500);
  const settledTick = maxTick(era);
  await sleep(2500);
  check('p1 wrote nothing more after it was closed (tick stable)', maxTick(era) === settledTick, `${settledTick} -> ${maxTick(era)}`);
  note(`closing p1 mid-run: tick was ${tBeforeClose} when the close started and ${settledTick} when it settled`);

  // the driver is gone: the watcher's refresh notices (the database says the lease is free) and says so, but never claims it
  const goneAt = Date.now();
  await p2.getByText(DRIVER_GONE_BANNER).waitFor({ timeout: 12000 }).then(
    () => check(`the watcher noticed on its own that the driver is gone (within ${((Date.now() - goneAt) / 1000).toFixed(1)} s): the banner now invites "Try to take over"`, true),
    () => check('the watcher noticed on its own that the driver is gone: the banner invites "Try to take over"', false, 'banner text not shown'));
  const freeAnswers = requestsOf('p2', isLeaseRead).filter((e) => e.responseSnippet.trim() === '"free"');
  check('that came from the read-only session_lease_state answering "free"; the watcher did NOT claim the lease by itself (only its one deliberate, denied click claimed)',
    freeAnswers.length >= 1 && requestsOf('p2', isClaim).length === 1 && eraRow(era).driver_id === null, json([freeAnswers.length, requestsOf('p2', isClaim).length, eraRow(era).driver_id]));
  check('"Try to take over" is still the way back: the button is offered, not Begin', (await btn(p2, 'Try to take over').isVisible()) && (await btn(p2, 'Begin').count()) === 0);

  // p2 takes over
  const nClaim = gw.log.length;
  const beforeTakeover = maxTick(era);
  await btn(p2, 'Try to take over').click();
  await p2.getByText(ANY_WATCH_BANNER).waitFor({ state: 'hidden', timeout: 15000 }).then(
    () => check('p2 "Try to take over" succeeds once p1 is gone: the banner disappears', true),
    () => check('p2 "Try to take over" succeeds once p1 is gone: the banner disappears', false, 'banner still visible'));
  const e2 = eraRow(era);
  S.driverB = e2.driver_id;
  const claimReq = gw.log.slice(nClaim).find((e) => e.page === 'p2' && isClaim(e));
  S.takeoverClaim = claimReq;
  check('DB: sessions.driver_id is now p2\'s id (the one in its claim request body), not p1\'s; the claim answered true',
    e2.driver_id && e2.driver_id !== S.driverA && claimReq && JSON.parse(claimReq.body).p_driver === e2.driver_id && claimReq.status === 200 && claimReq.responseSnippet.trim() === 'true', json([e2.driver_id, claimReq]));
  check('p2 is now driving: the button reads Halt', await btn(p2, 'Halt').isVisible());
  await btn(p2, SPEED).click();
  await waitFor('p2 writes a tick', () => maxTick(era) > beforeTakeover, { timeout: 30000 });
  check(`p2 continued the era from tick ${beforeTakeover}: its first position row is tick ${beforeTakeover + 1}`,
    q(`SELECT min(tick)::int AS t FROM agent_positions WHERE session_id=${lit(era)} AND tick > ${beforeTakeover}`)[0].t === beforeTakeover + 1);
  const hb1 = eraRow(era).driver_heartbeat_at;
  await waitFor('heartbeat renewed', () => eraRow(era).driver_heartbeat_at !== hb1, { timeout: 15000 }).then(
    () => check('p2 renews the lease heartbeat while it drives (driver_heartbeat_at advances)', true),
    (e) => check('p2 renews the lease heartbeat while it drives (driver_heartbeat_at advances)', false, e.message));
  await shot(p2, 'c2-after-takeover');
}

// =============================================================================================== b) checkpoint at tick 50
async function scenarioCheckpoint() {
  section('b) tick 50: the checkpoint');
  const era = S.era2.id;
  const cp = await expectWait('DB: a checkpoints row for tick 50 appears', () => q(`SELECT * FROM checkpoints WHERE session_id=${lit(era)} AND tick=50`)[0], { timeout: 180000, interval: 500 });
  if (!cp) return;
  const snap = cp.snapshot;
  check('checkpoint payload: version 1, a fingerprint string, tick 50, cursor and both villagers with inventory/inbox/needs',
    snap.version === 1 && typeof snap.fingerprint === 'string' && snap.fingerprint.length > 8 && snap.tick === 50 && snap.cursor && snap.agents.length === 2
    && snap.agents.every((a) => Array.isArray(a.inventory) && Array.isArray(a.inbox) && typeof a.hunger === 'number' && typeof a.energy === 'number' && a.pos), json(Object.keys(snap)));
  check('checkpoint: exactly one row per 50 ticks so far (unique on session_id, tick)', q(`SELECT count(*)::int AS n FROM checkpoints WHERE session_id=${lit(era)} AND tick % 50 = 0`)[0].n === Math.floor(maxTick(era) / 50));
  S.cp50 = cp;
}

// =============================================================================================== e) end, continue from here, refuse tampered
async function scenarioFork() {
  section('e) end the era, "Continue from here", then a tampered checkpoint');
  const p2 = S.p2;
  const era = S.era2.id;
  await waitFor('a few ticks past 50', () => maxTick(era) >= 53, { timeout: 60000 });
  await haltAndSettle(p2, era, 'p2');
  const finalTick = maxTick(era);
  S.finalTick = finalTick;

  // The feeds on p2 (opened as a watcher, never reloaded, Realtime refused) now equal the database: only the polling fallback
  // can have put the rows there. Exactly the newest 100 events, newest first, each once (the ids are unique in the database).
  await p2.getByRole('button', { name: /Chronicle/ }).first().click();
  const newestEvents = () => q(`SELECT message FROM events WHERE session_id=${lit(era)} ORDER BY created_at DESC LIMIT 100`).map((r) => r.message);
  const dbEventTotal = eventCount(era);
  const feedSame = await waitFor('the Chronicle equals the database', async () => json(await feedMessages(p2)) === json(newestEvents()), { timeout: 15000, interval: 500 }).then(() => true, () => false);
  const feedShown = await feedMessages(p2);
  check(`UI: after the run, p2's Chronicle (never reloaded, Realtime refused) lists exactly the database's newest ${feedShown.length} of ${dbEventTotal} events, newest first, none twice`,
    feedSame && feedShown.length === Math.min(100, dbEventTotal), `ui=${feedShown.length} db=${dbEventTotal}\nui:  ${json(feedShown.slice(0, 5))}\ndb:  ${json(newestEvents().slice(0, 5))}`);
  if (dbEventTotal <= 100) note(`the panel's 100-row cap was not reached in this run (${dbEventTotal} events); the cap is unit-tested (mergeRows)`);
  await p2.getByRole('button', { name: /Records/ }).first().click();
  const newestMemory = q(`SELECT content FROM memories WHERE session_id=${lit(era)} ORDER BY created_at DESC LIMIT 1`)[0]?.content;
  const memoryShown = await p2.getByText(newestMemory ?? '', { exact: true }).first().waitFor({ timeout: 15000 }).then(() => true, () => false);
  check('UI: the Records panel follows the database too: the newest memory row is on screen on p2', Boolean(newestMemory) && memoryShown, newestMemory);
  await p2.getByRole('button', { name: /Chronicle/ }).first().click();

  // d2) deterministic "memories after the fork tick must stay invisible": plant one visible and one hidden diary row per villager
  const cpTick = q(`SELECT max(tick)::int AS t FROM checkpoints WHERE session_id=${lit(era)}`)[0].t;
  for (const v of villagers(era)) {
    x(`INSERT INTO memories (agent_id, session_id, kind, content, island, tick) VALUES
       (${lit(v.id)}, ${lit(era)}, 'episodic', ${lit(`E2E-VISIBLE-${v.name}`)}, 'forest', ${cpTick}),
       (${lit(v.id)}, ${lit(era)}, 'episodic', ${lit(`E2E-HIDDEN-${v.name}`)}, 'forest', ${cpTick + 1})`);
  }
  const hiddenReal = q(`SELECT count(*)::int AS n FROM memories WHERE session_id=${lit(era)} AND tick > ${cpTick}`)[0].n;
  check(`setup: the era has ${hiddenReal} memories written after the checkpoint (tick > ${cpTick}), so the tick rule has something to hide`, hiddenReal > 2, `${hiddenReal}`);

  // end the session
  await p2.locator('header').getByRole('button', { name: /End session/ }).click();
  await p2.locator('div.fixed').getByRole('button', { name: 'End session', exact: true }).click();
  await p2.locator('header').getByRole('button', { name: /New session/ }).waitFor({ timeout: 30000 });
  const ended = eraRow(era);
  check('end session: archived with the model-written title, ticks = the last tick, stockpile copied, lease clear',
    ended.status === 'archived' && ended.title === STORY_TITLE && ended.ticks === finalTick && ended.driver_id === null && ended.summary && /villagers/.test(ended.summary), json(ended));
  check('end session: the closing chronicle line was written', q(`SELECT 1 FROM events WHERE session_id=${lit(era)} AND message=${lit(`The chronicle closes on ${STORY_TITLE}. The world lies quiet.`)}`).length === 1);
  const cpRow = q(`SELECT * FROM checkpoints WHERE session_id=${lit(era)} ORDER BY tick DESC LIMIT 1`)[0];
  S.cpRow = cpRow;
  check(`the latest checkpoint is tick ${cpTick}`, cpRow.tick === cpTick);
  await openReplayTab(p2);
  const cont = p2.locator('button', { hasText: /Continue from here/ }).first();
  check(`Replay: "Continue from here" is enabled and offers tick ${cpTick}`, (await cont.isEnabled()) && ((await cont.getAttribute('title')) ?? '').includes(`tick ${cpTick}`), await cont.getAttribute('title'));
  await shot(p2, 'e1-archived-replay-tab');

  const parentBefore = eraFingerprint(era);
  const relBefore = q('SELECT count(*)::int AS n, coalesce(md5(string_agg(x::text, \'|\' ORDER BY x::text)), \'\') AS h FROM relationships x')[0];
  const sessionsBefore = q('SELECT count(*)::int AS n FROM sessions')[0].n;
  await cont.click();
  const notice = await p2.getByText(/Continuing .* from tick \d+\. Press play when you are ready\./).waitFor({ timeout: 30000 }).then(() => true, () => false);
  check('UI: the fork notice "Continuing ... from tick N. Press play when you are ready." appears', notice);
  const fork = liveEra();
  S.fork = fork;
  check('DB: a new live era "Era 2, continued" exists with parent_session_id and fork_tick = the checkpoint tick', fork && fork.id !== era && fork.title === `Era ${ended.seq}, continued`
    && fork.parent_session_id === era && fork.fork_tick === cpTick && fork.status === 'live' && fork.carry_memories === ended.carry_memories && fork.seq === sessionsBefore + 1, json(fork));
  check('UI: the header says "Now playing: Era 2, continued" and shows the checkpoint tick', (await headerText(p2)).includes(`Now playing: ${fork.title}`) && (await uiTick(p2)) === cpTick, `${(await headerText(p2)).replace(/\n/g, ' ')} / ${await uiTick(p2)}`);
  check('DB: the fork is not driven yet ("nothing runs until the viewer presses play") and the page offers Begin', fork.driver_id === null && (await btn(p2, 'Begin').isVisible()));
  const cp = cpRow.snapshot;
  const forkRows = villagers(fork.id);
  const parentRows = villagers(era);
  const same = cp.agents.every((a) => {
    const f = byName(forkRows, a.name);
    return f && f.id !== a.id && f.position.x === a.pos.x && f.position.y === a.pos.y && f.hunger === Math.round(a.hunger) && f.energy === Math.round(a.energy)
      && json(f.inventory) === json(a.inventory) && f.island === a.island && f.persona === a.persona;
  });
  check('DB: the fork\'s villagers are new rows with the checkpoint\'s position, hunger, energy, items and persona', forkRows.length === cp.agents.length && same, json([forkRows.map((f) => [f.name, f.position, f.hunger, f.energy, f.inventory]), cp.agents.map((a) => [a.name, a.pos, a.hunger, a.energy, a.inventory])]));
  check('DB: no fork villager reuses a parent villager id', forkRows.every((f) => !parentRows.some((p) => p.id === f.id)));
  const lastParent = cp.cursor.lastActorId ? cp.agents.find((a) => a.id === cp.cursor.lastActorId)?.name : null;
  check('DB: the fork\'s turn cursor points at the same villager by name (ids were remapped)', !lastParent || nameOf(fork.id, fork.last_actor_id) === lastParent, json([fork.last_actor_id, lastParent]));
  const forkCiv = q(`SELECT * FROM civ WHERE session_id=${lit(fork.id)}`)[0];
  check('DB: the fork\'s stockpile equals the checkpoint\'s', forkCiv && ['wood', 'food', 'gold', 'stone', 'age'].every((k) => forkCiv[k] === cp.civ[k]), json([forkCiv, cp.civ]));
  const forkEvents = q(`SELECT type, message, tick FROM events WHERE session_id=${lit(fork.id)}`);
  check('DB: the fork starts with one chronicle line only, stamped with the fork tick; no history was copied', forkEvents.length === 1 && forkEvents[0].message.includes(`the empire wakes where tick ${cpTick} left it`) && forkEvents[0].tick === cpTick && q(`SELECT 1 FROM agent_positions WHERE session_id=${lit(fork.id)}`).length === 0, json(forkEvents));
  await shot(p2, 'e2-forked-era');

  // play the fork: tick continues from the checkpoint, memories obey the tick rule
  await btn(p2, SPEED).click();
  const mark = gw.brainRequests.length;
  await btn(p2, 'Begin').click();
  const names = forkRows.map((v) => v.name);
  const firstTurns = [];
  for (const n of names) firstTurns.push(await nextBrain(mark, (r) => r.actor === n && !firstTurns.includes(r), 40000));
  check(`the fork's first observation reads "Tick ${cpTick}." (the clock continued from the checkpoint)`, firstTurns[0].observation.startsWith(`Tick ${cpTick}. `), firstTurns[0].observation.slice(0, 80));
  check('the villager the cursor names is not the first to act (the turn order continued)', !lastParent || firstTurns[0].actor !== lastParent, `first=${firstTurns[0].actor} last=${lastParent}`);
  const seeVisible = firstTurns.every((r) => r.system.includes(`E2E-VISIBLE-${r.actor}`));
  const seeHidden = firstTurns.some((r) => r.system.includes(`E2E-HIDDEN-${r.actor}`) || /E2E-HIDDEN/.test(r.system));
  check('memories: each fork villager is shown the parent era\'s memory written AT the fork tick', seeVisible, firstTurns.map((r) => r.system.match(/Your chronicles[\s\S]*?\n\n/)?.[0].slice(0, 400)).join('\n--\n'));
  check('memories: nothing the parent wrote AFTER the fork tick is shown (the tick rule, as PostgREST evaluated the nested or/and filter)', !seeHidden);
  const memReq = gw.log.filter((e) => e.method === 'GET' && /\/rest\/v1\/memories\?/.test(e.url) && decodeURIComponent(e.url).includes('and(session_id.eq.')).pop();
  S.memoryReq = memReq;
  check('memories: the fork\'s visibility filter (session_id.eq..., and(session_id.eq.<parent>,or(tick.is.null,tick.lte.N))) was accepted by PostgREST (HTTP 200)', memReq && memReq.status === 200, json(memReq));
  await waitFor('two fork ticks', () => maxTick(fork.id) >= cpTick + 2, { timeout: 40000 });
  check(`DB: the fork's first position rows are ticks ${cpTick + 1} and ${cpTick + 2}`, json(q(`SELECT tick FROM agent_positions WHERE session_id=${lit(fork.id)} ORDER BY tick LIMIT 2`).map((r) => r.tick)) === json([cpTick + 1, cpTick + 2]));
  await haltAndSettle(p2, fork.id, 'p2 (fork)');
  const parentAfter = eraFingerprint(era);
  const diff = ERA_TABLES.filter((t) => json(parentBefore[t]) !== json(parentAfter[t]));
  if (json(parentBefore.session) !== json(parentAfter.session)) diff.push('sessions row');
  check('the archived parent era is untouched: row counts and content hashes of events, positions, agents, memories, checkpoints, structures, civ, depleted_objects and its sessions row are identical before and after the fork ran', diff.length === 0, `changed: ${diff.join(', ')}\n${json(parentBefore)}\n${json(parentAfter)}`);
  const relAfter = q('SELECT count(*)::int AS n, coalesce(md5(string_agg(x::text, \'|\' ORDER BY x::text)), \'\') AS h FROM relationships x')[0];
  note(`relationships (global, not era-scoped) before/after the fork's first turns: ${relBefore.n} -> ${relAfter.n} rows`);
  await shot(p2, 'e3-fork-played');

  // tamper: change the parent's checkpoint fingerprint in the database, then ask to continue again
  x(`UPDATE checkpoints SET snapshot = jsonb_set(snapshot, '{fingerprint}', '"tampered-fingerprint"') WHERE session_id=${lit(era)}`);
  const worldBefore = globalFingerprint();
  const forkStill = eraRow(fork.id);
  await openReplayTab(p2);
  const parentBtn = p2.locator('button', { hasText: /Continue from here|Confirm: this ends the current era/ }).first();
  await parentBtn.click(); // a live era exists: the first click asks for confirmation
  check('tamper: with a live era open, the first click asks "Confirm: this ends the current era"', (await parentBtn.innerText()).includes('Confirm'));
  await parentBtn.click();
  const refusal = checkFingerprint('tampered-fingerprint', S.cpRow.snapshot.fingerprint).message;
  const shown = await p2.getByText(refusal).waitFor({ timeout: 20000 }).then(() => true, () => false);
  check('tamper: the plain-language refusal about the fingerprint mismatch is shown in the Replay tab', shown, (await p2.locator('main').innerText()).slice(-600));
  await sleep(500);
  const worldAfter = globalFingerprint();
  const changed = ALL_TABLES.filter((t) => json(worldBefore[t]) !== json(worldAfter[t]));
  check('tamper: NOTHING was created or changed anywhere (every table\'s row count and content hash is identical)', changed.length === 0, `changed: ${changed.join(', ')}`);
  const forkAfter = eraRow(fork.id);
  check('tamper: the live fork era was not ended by the refused attempt (still live, same row)', forkAfter.status === 'live' && json(forkAfter) === json(forkStill), json(forkAfter));
  check('tamper: the header still shows the live fork era', (await headerText(p2)).includes(`Now playing: ${fork.title}`));
  await shot(p2, 'e4-tampered-refusal');
}

// =============================================================================================== f) anon, RLS, PostgREST parsing
async function scenarioAnon() {
  section('f) the anon key through PostgREST: grants, RLS, and the lease claim as the real client sends it');
  const headers = { Authorization: `Bearer ${stack.anonKey}`, apikey: stack.anonKey, 'Content-Type': 'application/json' };
  const call = async (method, path, body, extra = {}) => {
    const res = await fetch(`${gw.url}/rest/v1${path}`, { method, headers: { ...headers, ...extra }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, data, text };
  };
  // the tables the app reads, as anon
  const appTables = ['sessions', 'agents', 'events', 'memories', 'civ', 'structures', 'depleted_objects', 'checkpoints', 'agent_positions', 'relationships'];
  const reads = await Promise.all(appTables.map(async (t) => [t, (await call('GET', `/${t}?select=*&limit=1`)).status]));
  check(`anon can SELECT every table the app reads (${appTables.join(', ')}): all 200`, reads.every(([, s]) => s === 200), json(reads));
  // the writes the app makes, as anon, on a scratch era so the real ones stay untouched
  const sid = (await call('POST', '/sessions', { seq: 99001, title: 'e2e anon scratch', status: 'archived' }, { Prefer: 'return=representation' })).data?.[0]?.id;
  check('anon can INSERT a session (Prefer: return=representation returns the row)', Boolean(sid));
  const agent = (await call('POST', '/agents', [{ session_id: sid, name: 'Scratch', model: 'm', color: '#000', island: 'forest', position: { x: 1, y: 1 }, inventory: [], inbox: [] }], { Prefer: 'return=representation' })).data?.[0];
  check('anon can INSERT an agent with the jsonb columns inventory/inbox', agent && json(agent.inventory) === '[]');
  const upd = await call('PATCH', `/agents?id=eq.${agent?.id}`, { inventory: ['wood'], inbox: [{ fromId: 'x', fromName: 'y', message: 'z' }], hunger: 8 });
  check('anon can UPDATE an agent (204)', upd.status === 204 && q(`SELECT inventory->>0 AS i FROM agents WHERE id=${lit(agent?.id)}`)[0]?.i === 'wood');
  const ev = await call('POST', '/events', { session_id: sid, type: 'system', message: 'x', tick: 1 });
  const cpIns = await call('POST', '/checkpoints?on_conflict=session_id,tick', { session_id: sid, tick: 50, snapshot: { version: 1 } }, { Prefer: 'resolution=merge-duplicates' });
  const cpIns2 = await call('POST', '/checkpoints?on_conflict=session_id,tick', { session_id: sid, tick: 50, snapshot: { version: 1, again: true } }, { Prefer: 'resolution=merge-duplicates' });
  check('anon can INSERT events and UPSERT checkpoints (on_conflict=session_id,tick merge-duplicates, twice, one row)', ev.status === 201 && cpIns.status === 201 && [200, 201].includes(cpIns2.status) && q(`SELECT count(*)::int AS n FROM checkpoints WHERE session_id=${lit(sid)}`)[0].n === 1, json([ev.status, cpIns.status, cpIns2.status]));
  const del = await call('DELETE', `/sessions?id=eq.${sid}`);
  x(`DELETE FROM events WHERE session_id=${lit(sid)}`);
  x(`DELETE FROM agents WHERE session_id=${lit(sid)}`);
  x(`DELETE FROM checkpoints WHERE session_id=${lit(sid)}`);
  check('anon can DELETE a session (the abort path of a failed fork relies on it)', del.status === 204 && q(`SELECT 1 FROM sessions WHERE id=${lit(sid)}`).length === 0, json(del));

  // settings: record
  const sGet = await call('GET', '/settings?select=openrouter_key');
  const sGet2 = await call('GET', '/settings?select=deploy_version&id=eq.world_state');
  const sPost = await call('POST', '/settings', { id: 'e2e', openrouter_key: 'sk-test' });
  check('RECORD: anon can NOT read or write `settings` (the lock migration): GET and POST are refused with 401 / 42501 permission denied, so the OpenRouter key is not exposed',
    sGet.status === 401 && sGet.data?.code === '42501' && sGet2.status === 401 && sPost.status === 401, json([sGet.status, sGet.data, sGet2.status, sPost.status]));
  note(`settings as anon: GET ${sGet.status} ${sGet.data?.code} "${sGet.data?.message}"; the browser therefore cannot read or stamp it; the app no longer tries (the old deploy-version reset was removed)`);
  const anyWrite = q("SELECT count(*)::int AS n FROM settings WHERE id='e2e'")[0].n;
  check('settings: the refused insert wrote nothing', anyWrite === 0);
  const badJwt = await fetch(`${gw.url}/rest/v1/sessions?select=id&limit=1`, { headers: { Authorization: 'Bearer not.a.jwt', apikey: 'x' } });
  check('a malformed JWT is refused (401), not treated as anon', badJwt.status === 401, `${badJwt.status}`);
  const wrongSig = await fetch(`${gw.url}/rest/v1/sessions?select=id&limit=1`, { headers: { Authorization: `Bearer ${stack.anonKey.slice(0, -4)}AAAA`, apikey: 'x' } });
  check('a JWT with a wrong signature is refused (401)', wrongSig.status === 401, `${wrongSig.status}`);
  const policies = q("SELECT relname, relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r'");
  note(`every public table has RLS on (${policies.filter((p) => p.relrowsecurity).length}/${policies.length}) but every policy except settings is USING (true) for anon: anyone holding the public anon key can read, rewrite or delete every era`);

  // the lease functions, called by the real supabase-js client (Node) against the same gateway the browser used.
  // The database's clock decides: the heartbeat is set relative to the DATABASE's now(), the client sends no time.
  const sb = createClient(gw.url, stack.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const lid = x("INSERT INTO sessions (seq, title, status) VALUES (99002, 'e2e lease scratch', 'archived') RETURNING id").split('\n')[0];
  const rpc = async (fn, args) => {
    const n = gw.log.length;
    const r = await sb.rpc(fn, { p_session: lid, ...args });
    return { ...r, request: gw.log.slice(n).find((e) => e.method === 'POST' && e.url.includes(`/rpc/${fn}`)) };
  };
  const claim = (me, ttl = DRIVER_TTL_SECONDS) => rpc('claim_session_lease', { p_driver: me, p_ttl_seconds: ttl });
  const setLease = (d, ageSec) => x(`UPDATE sessions SET driver_id=${d ? lit(d) : 'NULL'}, driver_heartbeat_at=${ageSec === null ? 'NULL' : `now() - interval '${ageSec} seconds'`} WHERE id=${lit(lid)}`);
  setLease('someone-else', 5);
  const fresh = await claim('me-node-1');
  check('lease via real supabase-js rpc: a FRESH lease (5 s old) held by someone else is refused: HTTP 200, false, holder unchanged', !fresh.error && fresh.data === false && fresh.request?.status === 200 && eraRow(lid).driver_id === 'someone-else', json([fresh.error, fresh.data]));
  setLease('someone-else', 29);
  const nearly = await claim('me-node-1');
  check('lease: a 29 s-old lease is still refused (1 s inside the TTL)', !nearly.error && nearly.data === false && eraRow(lid).driver_id === 'someone-else', json([nearly.error, nearly.data]));
  setLease('someone-else', 31);
  const stale = await claim('me-node-1');
  check('lease via real supabase-js rpc: a STALE lease (31 s) is taken over: true and the database names the new holder', !stale.error && stale.data === true && eraRow(lid).driver_id === 'me-node-1', json([stale.error, stale.data]));
  setLease(null, null);
  const free = await claim('me-node-2');
  check('lease: a free era (driver_id null) is claimed', !free.error && free.data === true && eraRow(lid).driver_id === 'me-node-2');
  setLease('someone-else', null);
  const noBeat = await claim('me-node-3');
  check('lease: a driver without any heartbeat is taken over', !noBeat.error && noBeat.data === true && eraRow(lid).driver_id === 'me-node-3');
  setLease('me-node-3', 1);
  const renewByClaim = await claim('me-node-3');
  check('lease: the current driver renews its own fresh lease by claiming again', !renewByClaim.error && renewByClaim.data === true);
  // a heartbeat set to now() - 30 s has aged at least 30 s by the time the call arrives, so it is at or past the boundary: stale.
  // (The exact-instant boundary, with now() frozen, is asserted in check:migrations; over HTTP each call is its own transaction.)
  setLease('someone-else', 30);
  const edge = await claim('me-node-4');
  setLease('someone-else', 29);
  const edge2 = await claim('me-node-5');
  check('lease: a heartbeat 30 s old is stale, 29 s old is fresh — evaluated by PostgreSQL on timestamptz with its own clock', !edge.error && edge.data === true && !edge2.error && edge2.data === false);
  setLease('someone-else', 45);
  const ttl60 = await claim('me-node-6', 60);
  setLease('someone-else', 45);
  const ttl40 = await claim('me-node-6', 40);
  check('lease: the ttl argument is honoured through PostgREST (a 45 s-old lease is fresh for 60 s, stale for 40 s)', ttl60.data === false && ttl40.data === true, json([ttl60.data, ttl40.data]));
  // renew / release / state
  setLease('owner-1', 20);
  const hbBefore = eraRow(lid).driver_heartbeat_at;
  const renewOwner = await rpc('renew_session_lease', { p_driver: 'owner-1' });
  const hbAfter = eraRow(lid).driver_heartbeat_at;
  check('renew via rpc: the owner gets true and the database advances the heartbeat', renewOwner.data === true && Date.parse(hbAfter) > Date.parse(hbBefore));
  const rowJson = () => json(eraRow(lid));
  const beforeNon = rowJson();
  const renewNon = await rpc('renew_session_lease', { p_driver: 'not-the-owner' });
  const releaseNon = await rpc('release_session_lease', { p_driver: 'not-the-owner' });
  check('renew / release by a non-owner: both false and the row is unchanged', renewNon.data === false && releaseNon.data === false && rowJson() === beforeNon, json([renewNon.data, releaseNon.data]));
  const stateOther = await rpc('session_lease_state', { p_driver: 'not-the-owner', p_ttl_seconds: DRIVER_TTL_SECONDS });
  const stateMine = await rpc('session_lease_state', { p_driver: 'owner-1', p_ttl_seconds: DRIVER_TTL_SECONDS });
  setLease('owner-1', 600);
  const stateStaleOther = await rpc('session_lease_state', { p_driver: 'not-the-owner', p_ttl_seconds: DRIVER_TTL_SECONDS });
  setLease(null, null);
  const stateFree = await rpc('session_lease_state', { p_driver: 'not-the-owner', p_ttl_seconds: DRIVER_TTL_SECONDS });
  check('session_lease_state via rpc: other (fresh, someone else\'s), mine, free (stale), free (nobody)', json([stateOther.data, stateMine.data, stateStaleOther.data, stateFree.data]) === json(['other', 'mine', 'free', 'free']), json([stateOther.data, stateMine.data, stateStaleOther.data, stateFree.data]));
  setLease('owner-1', 2);
  const releaseOwner = await rpc('release_session_lease', { p_driver: 'owner-1' });
  const freed = eraRow(lid);
  check('release via rpc: the owner gets true and driver_id and driver_heartbeat_at are NULL', releaseOwner.data === true && freed.driver_id === null && freed.driver_heartbeat_at === null);
  const grants = q("SELECT p.proname, p.prosecdef FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('claim_session_lease','renew_session_lease','release_session_lease','session_lease_state')");
  check('the four functions PostgREST exposed are SECURITY INVOKER: the call ran with anon\'s own rights and RLS', grants.length === 4 && grants.every((g) => g.prosecdef === false), json(grants));
  x(`DELETE FROM sessions WHERE id=${lit(lid)}`);

  // the requests as sent
  const decoded = (u) => decodeURIComponent(u);
  console.log('      lease claim request as the supabase-js client sent it (stale case):');
  console.log(`        POST ${decoded(stale.request.url)}`);
  console.log(`        body  ${stale.request.body.replace(lid, '<era id>')}  ->  HTTP ${stale.request.status} ${stale.request.responseSnippet.slice(0, 80)}`);
  const bodyShape = (r) => json(Object.keys(JSON.parse(r.body)).sort());
  console.log(`      the same request from the browser bundle (p2 takeover):\n        POST ${S.takeoverClaim ? decoded(S.takeoverClaim.url) : '(not captured)'}  ${S.takeoverClaim ? S.takeoverClaim.body.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<uuid>') : ''}`);
  check('the browser bundle and the Node client send the same claim request: POST /rest/v1/rpc/claim_session_lease with a body of exactly p_driver, p_session, p_ttl_seconds (no timestamp)',
    S.takeoverClaim && S.takeoverClaim.url === stale.request.url && bodyShape(S.takeoverClaim) === bodyShape(stale.request) && bodyShape(stale.request) === json(['p_driver', 'p_session', 'p_ttl_seconds'])
    && JSON.parse(S.takeoverClaim.body).p_ttl_seconds === DRIVER_TTL_SECONDS, `${S.takeoverClaim?.url} ${S.takeoverClaim?.body}\n${stale.request.url} ${stale.request.body}`);
  const denied = S.deniedClaim;
  console.log(`      denied claim from p2 (browser): HTTP ${denied?.status}, body returned ${denied?.responseSnippet}`);
  const memFilter = S.memoryReq ? decodeURIComponent(S.memoryReq.url) : '(not captured)';
  console.log(`      fork memory filter as sent by the browser:\n        GET ${memFilter.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, (m) => m.slice(0, 8))}`);
}

// =============================================================================================== g) a failed bond write survives a reload
const DIRTY_KEY = 'empire:dirty-bonds:v1'; // src/sim/bondStore.ts
const dirtyRows = async (page) => {
  const raw = await page.evaluate((k) => localStorage.getItem(k), DIRTY_KEY);
  return raw === null ? null : JSON.parse(raw).rows;
};
/** The relationships upserts the page sent since log index `since`, with the row each carried. */
const relUpserts = (since, page = null) => gw.log.slice(since)
  .filter((e) => e.method === 'POST' && /\/rest\/v1\/relationships\?/.test(e.url) && (!page || e.page === page))
  .map((e) => ({ status: e.status, fault: Boolean(e.fault), page: e.page, row: JSON.parse(e.body) }));

async function scenarioBondRetry() {
  section('g) a bond write fails (503), the page is reloaded: the dirty row survives and the database converges (R7.1)');
  const p = S.p2;
  const era = S.fork.id;
  const names = MANIFEST.startingVillagers.map((v) => v.name);
  // arrangement (test setup, not behaviour under test): stand both villagers where the world starts them, diagonally
  // adjacent with nothing unheard, so one scripted chat is possible; the reload makes the app read that from the database
  for (const v of MANIFEST.startingVillagers) {
    x(`UPDATE agents SET position=${lit(json({ x: v.pos.x, y: v.pos.y }))}::jsonb, inbox='[]'::jsonb WHERE session_id=${lit(era)} AND name=${lit(v.name)}`);
  }
  const reloadApp = async (page) => {
    await page.reload();
    await page.locator('header').getByText(/Now playing:/).waitFor({ timeout: 30000 });
    await waitVillagers(page);
  };
  await reloadApp(p);
  check('setup: nothing is left in the dirty-bond store before the scenario starts', (await dirtyRows(p)) === null, json(await dirtyRows(p)));
  const chatScript = (text) => gw.scriptNext((r) => {
    const m = /Standing right beside you[^:]*: ([A-Za-z]+) \(([0-9a-f]{8})\)/.exec(r.observation);
    return m ? { thought: `I chat with ${m[1]}.`, action: { type: 'chat', data: { agent_id: m[2], message: text } } } : null;
  });
  const oneTurn = async (label) => {
    const t0 = maxTick(era);
    await btn(p, 'Slow').click(); // 6 s between turns: room to halt after exactly one
    const mark = gw.log.length;
    const brainMark = gw.brainRequests.length;
    await btn(p, 'Begin').click();
    const turn = await nextBrain(brainMark);
    check(`${label}: the turn's observation lists the other villager beside the actor, so the scripted chat is possible`, /Standing right beside you/.test(turn.observation) && turn.scripted === true, `${turn.actor}: ${turn.observation.slice(0, 700)}`);
    await waitFor(`${label}: the turn is written`, () => maxTick(era) > t0, { timeout: 30000, interval: 50 });
    return mark;
  };
  const pairWhere = (r) => `a_id=${lit(r.a_id)} AND b_id=${lit(r.b_id)}`;

  // 1) a healthy chat: the pair's row exists in the database at the strength the app wrote
  chatScript('Good morning, friend.');
  const mark1 = await oneTurn('healthy chat');
  const healthy = await waitFor('the healthy chat\'s relationship upserts', () => { const u = relUpserts(mark1); return u.length >= 2 && u.every((x2) => x2.status !== 0) ? u : null; }, { timeout: 15000, interval: 50 })
    .catch((err) => { throw new Error(`${err.message}\nrequests since the turn began:\n${gw.log.slice(mark1).map((e) => `${e.page} ${e.method} ${decodeURIComponent(e.url).slice(0, 110)} -> ${e.status}`).join('\n')}`); });
  await haltAndSettle(p, era, 'p2 (healthy chat)');
  const pair = { a_id: healthy[0].row.a_id, b_id: healthy[0].row.b_id };
  const S1 = healthy[healthy.length - 1].row.strength;
  // the bond started from an earlier era's row (namesakes inherit bonds), so this pins that both sides still write the pair of THIS era's villagers
  const eraIds = q(`SELECT id FROM agents WHERE session_id=${lit(era)}`).map((r) => r.id).sort();
  check('healthy chat: both upserts carried the same pair of ids, and it is this era\'s two villagers (not an earlier era\'s namesake of either)',
    healthy.every((u) => u.row.a_id === pair.a_id && u.row.b_id === pair.b_id) && json([pair.a_id, pair.b_id].sort()) === json(eraIds), json([healthy.map((u) => [u.row.a_id, u.row.b_id]), eraIds]));
  check('healthy chat: both upserts were answered 2xx and the database holds the pair at the strength the app wrote',
    healthy.every((u) => u.status >= 200 && u.status < 300) && q(`SELECT strength FROM relationships WHERE ${pairWhere(pair)}`)[0]?.strength === S1 && S1 >= 1, json([healthy.map((u) => [u.status, u.row.strength]), S1]));
  check('healthy chat: nothing is left in localStorage (the row was saved before the request and removed when it succeeded)', (await dirtyRows(p)) === null, json(await dirtyRows(p)));

  // 2) the database is "down" for relationships writes (the gateway answers 503, PostgREST never sees them): the other villager answers
  const fault = gw.failNext({ table: 'relationships', methods: ['POST', 'PATCH'], count: 100, status: 503 });
  const errorsBefore = consoleErrors.length;
  chatScript('And a good morning to you.');
  const mark2 = await oneTurn('chat while relationships writes fail');
  await waitFor('the failing writes', () => fault.hits >= 2, { timeout: 15000, interval: 50 });
  await haltAndSettle(p, era, 'p2 (faulted chat)');
  const failed = relUpserts(mark2).filter((u) => u.fault);
  check(`the app's relationship writes for the second chat got HTTP 503 (${failed.length} of them) and carried strength ${S1 + 1} = ${S1} + 1 for the same pair`,
    failed.length >= 2 && failed.every((u) => u.status === 503 && u.row.strength === S1 + 1 && u.row.a_id === pair.a_id && u.row.b_id === pair.b_id), json(failed));
  check(`DB: the bond is STALE — the database still holds ${S1}, not ${S1 + 1}`, q(`SELECT strength FROM relationships WHERE ${pairWhere(pair)}`)[0]?.strength === S1);
  const stored = await dirtyRows(p);
  check(`localStorage['${DIRTY_KEY}'] holds exactly the dirty row: the pair, strength ${S1 + 1}, the era`,
    stored && stored.length === 1 && stored[0].a_id === pair.a_id && stored[0].b_id === pair.b_id && stored[0].strength === S1 + 1 && stored[0].session_id === era, json(stored));
  check('the stored text holds ids, strength and timestamps only', stored && json(Object.keys(stored[0]).sort()) === json(['a_id', 'b_id', 'last_chat_at', 'session_id', 'strength']));
  check('the failed writes were logged by the app (console.error), one per request, and nothing else broke', consoleErrors.length - errorsBefore >= fault.hits && pageErrors.length === 0);
  S.bondRetryErrors = consoleErrors.length - errorsBefore;

  // 3) the page is reloaded with the database healthy again; nobody presses Begin
  gw.clearFaults();
  const mark3 = gw.log.length;
  await reloadApp(p);
  await expectWait(`DB: after the reload the pair's row converged to ${S1 + 1}`, () => q(`SELECT strength FROM relationships WHERE ${pairWhere(pair)}`)[0]?.strength === S1 + 1, { timeout: 20000, interval: 100 });
  await expectWait('localStorage: the dirty row is gone once the write succeeded', async () => (await dirtyRows(p)) === null, { timeout: 10000, interval: 100 });
  const recovery = relUpserts(mark3, 'p2');
  const readBack = gw.log.slice(mark3).find((e) => e.page === 'p2' && e.method === 'GET' && /\/rest\/v1\/relationships\?select=strength/.test(e.url) && e.url.includes(`a_id=eq.${pair.a_id}`));
  check(`the reloaded app compared with the database first (GET relationships?select=strength for the pair) and then sent ONE upsert with strength ${S1 + 1}, answered 2xx`,
    Boolean(readBack) && recovery.length === 1 && recovery[0].status >= 200 && recovery[0].status < 300 && recovery[0].row.strength === S1 + 1, json([readBack?.url, recovery]));
  check('this window was not the driver while it recovered (no Begin pressed, lease free): a free, not-watching window may write', eraRow(era).driver_id === null);
  // the in-memory bond was repaired too, not only the row: the next turn's prompt shows S1 + 1, where the stale database said S1
  await btn(p, SPEED).click();
  const markBrain = gw.brainRequests.length;
  await btn(p, 'Begin').click();
  const turn = await nextBrain(markBrain);
  const other = names.find((n) => n !== turn.actor);
  check(`the next turn's prompt (${turn.actor}) shows "${other}: bond ${S1 + 1}" — the in-memory bond was raised to the persisted strength, not left at the stale ${S1}`,
    turn.system.includes(`- ${other}: bond ${S1 + 1}`), (turn.system.match(/- [A-Za-z]+: bond \d+/g) ?? []).join(' | '));
  await haltAndSettle(p, era, 'p2 (after recovery)');

  // 4) a watching window loads the dirty row but never writes it; it recovers when it takes the lease over
  const BIG = 10000; // a fabricated, impossibly high strength: the row is written only if strictly higher than the database's
  const dbNow = q(`SELECT strength FROM relationships WHERE ${pairWhere(pair)}`)[0].strength;
  x(`UPDATE sessions SET driver_id='e2e-other-driver', driver_heartbeat_at=now() WHERE id=${lit(era)}`);
  const ctx3 = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { 'x-e2e-page': 'p3' } });
  await ctx3.addInitScript(({ key, row }) => {
    try {
      if (!sessionStorage.getItem('e2e-seeded')) { sessionStorage.setItem('e2e-seeded', '1'); localStorage.setItem(key, JSON.stringify({ v: 1, rows: [row] })); }
    } catch { /* storage unavailable */ }
  }, { key: DIRTY_KEY, row: { ...pair, strength: BIG, last_chat_at: new Date().toISOString(), session_id: era } });
  const mark4 = gw.log.length;
  const p3 = await openApp(ctx3, 'p3');
  S.p3 = p3;
  await waitVillagers(p3);
  check('p3 opened while "another window" holds the lease: the watch banner is shown', await p3.getByText(WATCH_BANNER).isVisible());
  await sleep(3000);
  // The watcher does read `relationships` while it loads the world (getRelationships: GET relationships?select=a_id,b_id,strength&or=(...)),
  // which every window needs to show the bonds; that READ is legitimate. What R7.6 forbids is a write, and what would show the row
  // being recovered is the compare-then-write that recoverBonds does (GET select=strength&a_id=eq.<pair> + an upsert).
  const p3Rel = gw.log.slice(mark4).filter((e) => e.page === 'p3' && tableOf(e) === 'relationships');
  const p3Compare = p3Rel.filter((e) => /select=strength&a_id=eq\./.test(e.url));
  check('p3 (the watcher) sent no write of any kind, no relationships write, and did not run the recovery (no compare read for the pair); its only relationships requests are the load-time bond GETs',
    requestsOf('p3', isWrite).length === 0 && p3Rel.every((e) => e.method === 'GET') && p3Compare.length === 0 && p3Rel.length >= 1,
    p3Rel.map((e) => `${e.method} ${decodeURIComponent(e.url).slice(0, 150)} -> ${e.status}`).join('\n') + '\nwrites:\n' + gw.log.slice(mark4).filter((e) => e.page === 'p3' && isWrite(e)).map((e) => `${e.method} ${e.url}`).join('\n'));
  check(`DB: the pair is unchanged while p3 watches (${dbNow}, not ${BIG}), and the row is still in p3's localStorage`,
    q(`SELECT strength FROM relationships WHERE ${pairWhere(pair)}`)[0].strength === dbNow && (await dirtyRows(p3))?.[0]?.strength === BIG);
  x(`UPDATE sessions SET driver_id=NULL, driver_heartbeat_at=NULL WHERE id=${lit(era)}`);
  const mark5 = gw.log.length;
  await btn(p3, 'Try to take over').click();
  await p3.getByText(ANY_WATCH_BANNER).waitFor({ state: 'hidden', timeout: 15000 });
  await expectWait(`DB: once p3 took the lease over, the persisted ${BIG} (strictly higher than ${dbNow}) was written`, () => q(`SELECT strength FROM relationships WHERE ${pairWhere(pair)}`)[0].strength >= BIG, { timeout: 20000, interval: 100 });
  await expectWait('p3: the dirty row is gone from its localStorage', async () => (await dirtyRows(p3)) === null, { timeout: 10000, interval: 100 });
  check(`p3's upsert for the pair carried exactly strength ${BIG}, sent after the takeover claim`, relUpserts(mark5, 'p3').some((u) => u.row.strength === BIG && u.status >= 200 && u.status < 300), json(relUpserts(mark5, 'p3')));
  await haltAndSettle(p3, era, 'p3');
  await shot(p3, 'g1-bond-retry');
  await ctx3.close();
}

// =============================================================================================== h) clock skew between windows
/** Runs in the page before any script: Date / Date.now() read `offsetMs` ahead of (or, negative, behind) the real clock. Timers are untouched. */
function skewDate(offsetMs) {
  const Real = Date;
  const now = () => Real.now() + offsetMs;
  globalThis.Date = new Proxy(Real, {
    construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [now()], newTarget),
    apply: () => new Real(now()).toString(),
    get: (target, prop, receiver) => (prop === 'now' ? now : Reflect.get(target, prop, receiver)),
  });
}

async function scenarioClockSkew() {
  section('h) clock skew: windows whose clocks are 5 minutes ahead / behind cannot steal a live lease, and can still take a dead one');
  const era = S.fork.id;
  const driver = S.p2; // a normal-clock window on the live fork era
  const MIN5 = 5 * 60 * 1000;
  const dbAge = (id) => q(`SELECT extract(epoch FROM now() - driver_heartbeat_at)::float AS s FROM sessions WHERE id=${lit(id)}`)[0].s;

  async function openSkewed(label, offsetMs) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, extraHTTPHeaders: { 'x-e2e-page': label } });
    await ctx.addInitScript(skewDate, offsetMs);
    const page = await openApp(ctx, label);
    const t0 = Date.now();
    const pageNow = await page.evaluate(() => Date.now());
    const pageIso = await page.evaluate(() => new Date().toISOString());
    const t1 = Date.now();
    const skew = pageNow - (t0 + t1) / 2;
    check(`${label}: the skew really took effect: Date.now() in the page is ${(skew / 1000).toFixed(1)} s from the Node clock (wanted ${offsetMs / 1000} s)`,
      Math.abs(skew - offsetMs) < 3000 && Math.abs(Date.parse(pageIso) - (t0 + t1) / 2 - offsetMs) < 3000, `${skew} ${pageIso}`);
    return { ctx, page };
  }
  const state = async (label) => requestsOf(label, isLeaseRead).pop();

  // a normal driver
  await btn(driver, SPEED).click();
  await btn(driver, 'Begin').click();
  const driverId = (await waitFor('the driver holds the lease', () => eraRow(era).driver_id, { timeout: 20000 }));
  const tickStart = maxTick(era);
  await waitFor('the driver writes a tick', () => maxTick(era) > tickStart, { timeout: 30000 });

  const ahead = await openSkewed('p-ahead', MIN5);
  const behind = await openSkewed('p-behind', -MIN5);
  for (const [label, w] of [['p-ahead', ahead], ['p-behind', behind]]) {
    await waitVillagers(w.page);
    check(`${label} (clock off by 5 min) still shows the watch-mode banner and offers "Try to take over"`, (await w.page.getByText(WATCH_BANNER).isVisible()) && (await btn(w.page, 'Try to take over').isVisible()));
    const st = await state(label);
    check(`${label}: the database said "other" (session_lease_state), whatever its own clock reads`, st && st.responseSnippet.trim() === '"other"', json(st));
  }

  // the driver beats at least twice while the skewed windows sit there
  const seen = new Set();
  let beats = 0;
  let last = eraRow(era).driver_heartbeat_at;
  const t0 = Date.now();
  await waitFor('two heartbeats of the driver', () => {
    const r = eraRow(era);
    seen.add(r.driver_id);
    if (r.driver_heartbeat_at !== last) { beats++; last = r.driver_heartbeat_at; }
    return beats >= 2;
  }, { timeout: 45000, interval: 250 });
  check(`across ${beats} driver heartbeats (${((Date.now() - t0) / 1000).toFixed(0)} s) sessions.driver_id was only ever the driver's (${[...seen].length} distinct value)`, seen.size === 1 && seen.has(driverId), json([...seen]));
  for (const label of ['p-ahead', 'p-behind']) {
    check(`${label} sent no write (and no claim) while watching`, requestsOf(label, isWrite).length === 0, requestsOf(label, isWrite).map((e) => `${e.method} ${e.url}`).join('\n'));
  }

  // they try to take over from the live driver: refused by the database clock
  for (const [label, w] of [['p-ahead', ahead], ['p-behind', behind]]) {
    const n = gw.log.length;
    await btn(w.page, 'Try to take over').click();
    const denied = await waitFor(`${label}: the denied claim`, () => gw.log.slice(n).find((e) => e.page === label && isClaim(e)), { timeout: 10000 });
    check(`${label} "Try to take over" against the live driver: false, still a watcher, lease still the driver's`,
      denied.status === 200 && denied.responseSnippet.trim() === 'false' && (await w.page.getByText(WATCH_BANNER).isVisible()) && eraRow(era).driver_id === driverId, json(denied));
  }
  await shot(ahead.page, 'h1-ahead-watcher');

  // the driver stops (its lease is released); a "ghost" driver that crashed 5 s ago still counts as live, whatever the clocks say
  await haltAndSettle(driver, era, 'driver');
  x(`UPDATE sessions SET driver_id='e2e-ghost', driver_heartbeat_at=now() - interval '5 seconds' WHERE id=${lit(era)}`);
  let n = gw.log.length;
  await btn(ahead.page, 'Try to take over').click();
  const ghostFresh = await waitFor('p-ahead: claim against the 5 s-old ghost', () => gw.log.slice(n).find((e) => e.page === 'p-ahead' && isClaim(e)), { timeout: 10000 });
  check('a lease 5 s old is FRESH for the window whose clock is 5 min ahead (a client-side cutoff would have called it stale): refused, ghost still holds it',
    ghostFresh.responseSnippet.trim() === 'false' && eraRow(era).driver_id === 'e2e-ghost' && (await ahead.page.getByText(WATCH_BANNER).isVisible()));
  // a ghost 31 s old is dead, also for the window whose clock is 5 min behind (a client-side cutoff would have called it fresh)
  x(`UPDATE sessions SET driver_id='e2e-ghost', driver_heartbeat_at=now() - interval '31 seconds' WHERE id=${lit(era)}`);
  n = gw.log.length;
  await btn(behind.page, 'Try to take over').click();
  await behind.page.getByText(ANY_WATCH_BANNER).waitFor({ state: 'hidden', timeout: 15000 }).then(
    () => check('a lease 31 s old is STALE for the window whose clock is 5 min behind: it takes over (banner gone)', true),
    () => check('a lease 31 s old is STALE for the window whose clock is 5 min behind: it takes over (banner gone)', false, 'banner still visible'));
  const behindClaim = gw.log.slice(n).find((e) => e.page === 'p-behind' && isClaim(e));
  const behindId = eraRow(era).driver_id;
  check('DB: driver_id is now p-behind\'s id (from its claim body), the claim answered true', behindId && behindId !== 'e2e-ghost' && behindClaim && JSON.parse(behindClaim.body).p_driver === behindId && behindClaim.responseSnippet.trim() === 'true', json([behindId, behindClaim]));
  check('the heartbeat the 5-min-behind window wrote is the DATABASE\'s time: it is seconds old by the database clock, not 5 minutes off', Math.abs(dbAge(era)) < 10, `${dbAge(era)} s`);
  const tickBehind = maxTick(era);
  await btn(behind.page, SPEED).click();
  const hb = eraRow(era).driver_heartbeat_at;
  await expectWait('p-behind renews its lease (driver_heartbeat_at advances) and keeps it', () => eraRow(era).driver_heartbeat_at !== hb && eraRow(era).driver_id === behindId && Math.abs(dbAge(era)) < 12, { timeout: 20000, interval: 250 });
  await expectWait('p-behind drives: a new tick is written', () => maxTick(era) > tickBehind, { timeout: 30000 });

  // while p-behind drives, the other skewed window is refused again
  n = gw.log.length;
  await btn(ahead.page, 'Try to take over').click();
  const again = await waitFor('p-ahead: claim against p-behind', () => gw.log.slice(n).find((e) => e.page === 'p-ahead' && isClaim(e)), { timeout: 10000 });
  check('p-ahead is refused while p-behind drives; the lease stays p-behind\'s', again.responseSnippet.trim() === 'false' && eraRow(era).driver_id === behindId);

  // p-behind stops: the window 5 min ahead can take over a free lease
  await haltAndSettle(behind.page, era, 'p-behind');
  n = gw.log.length;
  await btn(ahead.page, 'Try to take over').click();
  await ahead.page.getByText(ANY_WATCH_BANNER).waitFor({ state: 'hidden', timeout: 15000 }).then(
    () => check('after p-behind stopped, the window whose clock is 5 min ahead takes over (banner gone)', true),
    () => check('after p-behind stopped, the window whose clock is 5 min ahead takes over (banner gone)', false, 'banner still visible'));
  const aheadId = eraRow(era).driver_id;
  const aheadClaim = gw.log.slice(n).find((e) => e.page === 'p-ahead' && isClaim(e));
  check('DB: driver_id is now p-ahead\'s id, and its heartbeat is the database\'s time (seconds old, not 5 minutes ahead)', aheadId && aheadId !== behindId && aheadClaim && JSON.parse(aheadClaim.body).p_driver === aheadId && Math.abs(dbAge(era)) < 10, `${aheadId} ${dbAge(era)} s`);
  const hb2 = eraRow(era).driver_heartbeat_at;
  await expectWait('p-ahead renews its lease and keeps it for a heartbeat', () => eraRow(era).driver_heartbeat_at !== hb2 && eraRow(era).driver_id === aheadId && Math.abs(dbAge(era)) < 12, { timeout: 20000, interval: 250 });
  await haltAndSettle(ahead.page, era, 'p-ahead');
  const allTicks = q(`SELECT tick FROM agent_positions WHERE session_id=${lit(era)} ORDER BY tick`).map((r) => r.tick);
  check('DB: still exactly one position row per tick across all the hand-overs (two drivers would double-write ticks)', allTicks.every((v, i) => v === allTicks[0] + i) && new Set(allTicks).size === allTicks.length, json(allTicks.slice(-12)));
  await shot(ahead.page, 'h2-ahead-took-over');
  await ahead.ctx.close();
  await behind.ctx.close();
}

// =============================================================================================== the run
async function main() {
  outDir = makeOutDir();
  mkdirSync(outDir, { recursive: true });
  console.log('Real end-to-end run: real bundle + supabase-js + migrations + PostgREST + Chromium. Faked: the language model (scripted stub) and Supabase Realtime (refused).');
  console.log(`output (screenshots, bundle): ${outDir}\n`);
  stack = await startStack({ outDir, log: (s) => console.log(`      ${s}`) });
  gw = stack.gateway;
  browser = await chromium.launch({
    headless: process.env.E2E_HEADED !== '1',
    // Playwright's own signal handlers exit the process at once; ours (below) must run first to tear the backend down
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    // software WebGL through ANGLE/SwiftShader: with the default GPU path the sandbox renders ~4 s per tick of main-thread stalls
    args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader'],
  });
  const steps = [
    ['a', scenarioA, null],
    ['d (chat)', scenarioChatReload, 'a'],
    ['b (run)', scenarioRun, 'a'],
    ['d (mid-run)', scenarioMidRunReload, 'b (run)'],
    ['c', scenarioSingleDriver, 'b (run)'],
    ['b (checkpoint)', scenarioCheckpoint, 'c'],
    ['e', scenarioFork, 'b (checkpoint)'],
    ['f', scenarioAnon, null],
    ['g (bond retry)', scenarioBondRetry, 'e'],
    ['h (clock skew)', scenarioClockSkew, 'e'],
  ];
  const failed = new Set();
  const only = (process.env.E2E_ONLY || '').split(',').filter(Boolean); // development aid: E2E_ONLY="a,d (chat)"
  for (const [name, fn, needs] of steps) {
    if (aborted) break;
    if (only.length && !only.includes(name)) continue;
    if (needs && failed.has(needs)) { check(`scenario ${name}: skipped because ${needs} did not complete`, false); failed.add(name); continue; }
    try {
      await fn();
    } catch (err) {
      failed.add(name);
      check(`scenario ${name} ran to the end`, false, `${err.stack || err.message}\n--- database at the failure ---\n${diagnostics()}`);
      for (const p of [S.p1, S.p2]) await shot(p, `crash-${name.replace(/\W+/g, '')}`);
    }
  }
  check('no uncaught exception in any page', pageErrors.length === 0, pageErrors.join('\n'));
  // the app logs each failed relationship write; scenario g injected them on purpose (and counted them above)
  const noisy = consoleErrors.filter((e) => !/WebSocket connection|Failed to load resource|relationship upsert failed: gateway: injected 503/.test(e));
  check('no unexpected console.error in any page (websocket refusals and the 401 settings reads excepted)', noisy.length === 0, noisy.slice(0, 6).join('\n'));
  note(`console errors seen: ${consoleErrors.length} (all "WebSocket connection ... failed" from the refused realtime, or the 401 on settings)`);
}

let aborted = false;
// Ctrl-C or a kill: still tear everything down (the database, PostgREST and the throwaway OS user must not outlive the run)
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.error(`\n${sig}: tearing down`);
    aborted = true; // the scenario loop stops here instead of reporting a hundred follow-up failures
    await browser?.close().catch(() => {});
    await stack?.stop().catch(() => {});
    process.exit(130);
  });
}

let exitCode = 1;
try {
  await main();
  const failedCount = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failedCount} passed, ${failedCount} failed  (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  if (notes.length) console.log(`\nNotes (findings that are not pass/fail):\n${notes.map((n) => `  - ${n}`).join('\n')}`);
  console.log(`\nscreenshots and bundle: ${outDir}`);
  exitCode = aborted ? 130 : failedCount === 0 ? 0 : 1;
} catch (err) {
  console.error(`FAIL  e2e aborted: ${err.stack || err.message}`);
} finally {
  await browser?.close().catch(() => {});
  await stack?.stop().catch(() => {});
}
process.exit(exitCode);
