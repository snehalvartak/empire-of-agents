/**
 * One-port stand-in for the parts of a Supabase project that sit in front of the database
 * (dependency-free node:http):
 *
 *   /rest/v1/*                  -> the REAL PostgREST (prefix stripped; method, headers incl.
 *                                  Authorization / apikey / Prefer / Content-Profile / Accept-Profile,
 *                                  and body forwarded; status, headers and body returned as they are)
 *   /functions/v1/agent-brain   -> scripts/stub-model-server.mjs's handler (a scripted villager, NO model);
 *                                  the chronicle-title request gets a fixed title so it does not use up a turn
 *   /functions/v1/settings-key  -> {set:true} (so the app starts without the "Add API key" flow); POST accepts a key
 *   /realtime/v1                -> websocket upgrades are REFUSED (404): Supabase Realtime is not available here
 *   OPTIONS anywhere            -> CORS preflight answered (the app and the gateway are different origins)
 *
 * Fault injection (OFF by default; only a scenario that asks for it): failNext() makes the next N matching
 * /rest/v1 requests answer 503 from the gateway itself, without reaching PostgREST, so the database never sees them.
 *
 * Everything that passes is logged (method, URL exactly as the client sent it, status, a short body
 * snippet, and the `x-e2e-page` header the driver adds per browser context), so a test can show the
 * real HTTP the supabase-js client generated.
 */
import http from 'node:http';
import { Readable } from 'node:stream';
import { createStubHandler } from '../stub-model-server.mjs';

const MAX_LOG = 100000;

export function startGateway({ postgrestUrl, anonKey, port = 0 }) {
  const stub = createStubHandler({ anonKey });
  const log = [];
  const brainRequests = [];
  const realtimeAttempts = [];
  const settings = { set: true, posts: 0 };
  const upstream = new URL(postgrestUrl);
  /** One-shot override of the scripted villager (see scriptNext). */
  let nextScript = null;
  /** Armed faults (none unless a scenario calls failNext): { table, methods, remaining, status, hits }. */
  const faults = [];

  const cors = (req) => ({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Location, Preference-Applied, Range-Unit',
    'Access-Control-Max-Age': '600',
  });

  const record = (req, status, body, extra = {}) => {
    const entry = {
      at: Date.now(),
      page: req.headers['x-e2e-page'] || null,
      method: req.method,
      url: req.url,
      status,
      body: body && body.length ? body.toString('utf8').slice(0, 600) : '',
      ...extra,
    };
    log.push(entry);
    if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
    return entry;
  };

  const json = (req, res, status, obj) => {
    res.writeHead(status, { ...cors(req), 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors(req));
      res.end();
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const path = req.url.split('?')[0];

      if (path.startsWith('/rest/v1/') || path === '/rest/v1') {
        const table = (/^\/rest\/v1\/([a-z_]+)/.exec(path) ?? [])[1] ?? null;
        const fault = faults.find((f) => f.remaining > 0 && f.table === table && f.methods.includes(req.method));
        if (fault) {
          fault.remaining--;
          fault.hits++;
          record(req, fault.status, body, { fault: true });
          json(req, res, fault.status, { message: `gateway: injected ${fault.status} (e2e fault injection)` });
          return;
        }
        const headers = { ...req.headers, host: upstream.host };
        delete headers.connection;
        delete headers['x-e2e-page'];
        delete headers.origin;
        delete headers.referer;
        headers['content-length'] = String(body.length);
        const target = req.url.replace(/^\/rest\/v1/, '') || '/';
        const preq = http.request({ host: upstream.hostname, port: upstream.port, method: req.method, path: target, headers }, (pres) => {
          const out = [];
          pres.on('data', (c) => out.push(c));
          pres.on('end', () => {
            const resBody = Buffer.concat(out);
            const h = { ...pres.headers };
            for (const k of Object.keys(h)) if (k.startsWith('access-control-')) delete h[k];
            delete h['transfer-encoding'];
            delete h.connection;
            h['content-length'] = String(resBody.length);
            record(req, pres.statusCode, body, { responseSnippet: resBody.toString('utf8').slice(0, 300) });
            res.writeHead(pres.statusCode, { ...h, ...cors(req) });
            res.end(resBody);
          });
        });
        preq.on('error', (err) => {
          record(req, 502, body, { error: String(err.message) });
          json(req, res, 502, { message: `gateway: PostgREST unreachable (${err.message})` });
        });
        preq.end(body);
        return;
      }

      if (path === '/functions/v1/agent-brain' && req.method === 'POST') {
        let parsed = null;
        try { parsed = JSON.parse(body.toString('utf8')); } catch { /* the stub answers 400 */ }
        const system = String(parsed?.messages?.[0]?.content ?? '');
        const observation = String(parsed?.messages?.[parsed?.messages?.length - 1]?.content ?? '');
        const authorized = req.headers.authorization === `Bearer ${anonKey}`;
        if (authorized && system.startsWith('You name the chronicle of a fallen')) {
          // the era's story title: a fixed one, and not a villager turn (so the stub's fault rotation is not disturbed)
          const content = JSON.stringify({ thought: 'The Dawn of the Stubborn Hearth', action: { type: 'wait', data: {} } });
          record(req, 200, Buffer.alloc(0), { kind: 'title' });
          json(req, res, 200, { id: 'stub-title', object: 'chat.completion', model: parsed.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] });
          return;
        }
        const entry = record(req, 0, Buffer.alloc(0), { kind: 'brain' });
        let scripted = null;
        if (parsed) {
          const brainReq = {
            at: entry.at,
            page: entry.page,
            actor: system.match(/^You are ([^,\n]+),/)?.[1] ?? null,
            system,
            observation,
            retry: system.includes('CRITICAL: Your previous reply was not valid') || /Your thought ".*" (does not describe|does not cover)/s.test(system),
          };
          brainRequests.push(brainReq);
          if (nextScript && !brainReq.retry) {
            const reply = nextScript(brainReq);
            if (reply) { nextScript = null; scripted = reply; brainReq.scripted = true; }
          }
        }
        if (scripted) {
          entry.status = 200;
          json(req, res, 200, { id: 'stub-scripted', object: 'chat.completion', model: parsed.model, choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(scripted) }, finish_reason: 'stop' }] });
          return;
        }
        const fake = Object.assign(Readable.from([body]), { method: req.method, url: req.url, headers: req.headers });
        const orig = res.writeHead.bind(res);
        res.writeHead = (status, headers) => orig(status, { ...headers, ...cors(req) });
        res.on('finish', () => { entry.status = res.statusCode; });
        stub.handler(fake, res);
        return;
      }

      if (path === '/functions/v1/settings-key') {
        if (req.headers.authorization !== `Bearer ${anonKey}`) { record(req, 401, body); json(req, res, 401, { message: 'Invalid JWT' }); return; }
        if (req.method === 'GET') { record(req, 200, body); json(req, res, 200, { set: settings.set }); return; }
        if (req.method === 'POST') {
          settings.posts++;
          settings.set = true;
          record(req, 200, Buffer.from('[key redacted]'));
          json(req, res, 200, { set: true });
          return;
        }
      }

      record(req, 404, body);
      json(req, res, 404, { error: `gateway: no route for ${req.method} ${path}` });
    });
  });

  server.on('upgrade', (req, socket) => {
    realtimeAttempts.push({ at: Date.now(), url: req.url });
    record(req, 404, Buffer.alloc(0), { kind: 'websocket-refused' });
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        url: `http://127.0.0.1:${actual}`,
        log,
        brainRequests,
        realtimeAttempts,
        stubStats: stub.stats,
        /**
         * The language model stays fake; this lets a scenario choose ONE villager reply so the app produces a
         * state the scripted policy never would (e.g. a chat). `fn(brainRequest)` returns { thought, action }
         * to answer that request, or null to leave it to the stub and be asked again on the next request.
         */
        scriptNext: (fn) => { nextScript = fn; },
        /**
         * Fault injection, off by default: the next `count` requests with one of `methods` to /rest/v1/<table> are answered
         * with `status` (default 503) by the gateway and never reach PostgREST. Returns the fault, whose `hits` counts the
         * requests it failed so far. clearFaults() disarms everything.
         */
        failNext: ({ table, methods = ['POST', 'PATCH'], count = 1, status = 503 }) => {
          const fault = { table, methods, remaining: count, status, hits: 0 };
          faults.push(fault);
          return fault;
        },
        clearFaults: () => { faults.length = 0; },
        settings,
        stop: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
      });
    });
  });
}
