import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getConnInfo } from '@hono/node-server/conninfo';
import { hostname } from 'node:os';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const normalize = (ip) => ip?.replace(/^::ffff:/, '');

export function createApp({ pool, bindHost, clientIp, remoteAddress = (c) => getConnInfo(c).remote.address }) {
  const app = new Hono();
  // A process-scoped form token protects this single-client, pre-login demo from CSRF.
  const csrf = randomBytes(32).toString('hex');
  app.use('*', async (c, next) => {
    const start = performance.now();
    c.set('dbMs', 0);
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (normalize(remoteAddress(c)) !== clientIp) {
      c.header('Server-Timing', `app;dur=${(performance.now() - start).toFixed(3)}, db;dur=0`);
      return c.text('Forbidden', 403);
    }
    await next();
    const db = c.get('dbMs');
    c.header('Server-Timing', `app;dur=${Math.max(0, performance.now() - start - db).toFixed(3)}, db;dur=${db.toFixed(3)}`);
  });
  app.use('*', bodyLimit({ maxSize: 8192, onError: (c) => c.text('Request too large', 413) }));
  async function query(c, sql, values) {
    const start = performance.now();
    try { return await pool.query(sql, values); }
    finally { c.set('dbMs', c.get('dbMs') + performance.now() - start); }
  }
  app.get('/healthz', (c) => c.json({ ok: true }));
  app.get('/healthz/db', async (c) => {
    await query(c, 'SELECT 1');
    return c.json({ ok: true, dbMs: c.get('dbMs') });
  });
  app.get('/', async (c) => {
    const { rows } = await query(c, 'SELECT id, text, created_at FROM notes ORDER BY id DESC LIMIT 100');
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>doxx · Private notes</title><style>
      :root{color-scheme:light dark;font-family:system-ui,sans-serif}body{max-width:760px;margin:6vh auto;padding:24px;line-height:1.6}header{border-bottom:1px solid #888;padding-bottom:20px}h1{font-size:2.8rem;margin:8px 0}small{letter-spacing:.08em}dl{display:grid;grid-template-columns:100px 1fr;overflow-wrap:anywhere}dd{margin:0}textarea{box-sizing:border-box;width:100%;padding:12px;font:inherit;border:1px solid #888;border-radius:6px}button{padding:10px 20px;font:inherit;margin-top:10px;cursor:pointer}article{border-top:1px solid #888;padding:16px 0}article p{white-space:pre-wrap;overflow-wrap:anywhere}.muted{opacity:.7}
      </style></head><body><header><small>DOXX / AWS NETWORK TEST</small><h1>Private notes.</h1><p>Reached through your doxx tunnel. Stored in PostgreSQL.</p><dl><dt>Host</dt><dd>${escapeHtml(hostname())}</dd><dt>Tunnel</dt><dd>${escapeHtml(bindHost)}</dd><dt>Caller</dt><dd>${escapeHtml(normalize(remoteAddress(c)))}</dd></dl></header><main><h2>Add a note</h2><form method="post" action="/notes"><input type="hidden" name="csrf" value="${csrf}"><label for="text">Test note</label><textarea id="text" name="text" rows="3" maxlength="2000" required></textarea><button type="submit">Save note</button></form><h2>Latest notes</h2>${rows.length ? rows.map((row) => `<article data-note-id="${row.id}"><p>${escapeHtml(row.text)}</p><time class="muted">${escapeHtml(new Date(row.created_at).toISOString())}</time></article>`).join('') : '<p class="muted">No notes yet. Add one to test persistence.</p>'}</main><footer><p class="muted">Stage 1 · HTTP over WireGuard · No application login yet</p></footer></body></html>`);
  });
  async function validateForm(c) {
    const origin = c.req.header('origin');
    if (origin && origin !== new URL(c.req.url).origin) return c.text('Forbidden', 403);
    if (!c.req.header('content-type')?.startsWith('application/x-www-form-urlencoded')) return c.text('Unsupported content type', 415);
    const form = new URLSearchParams(await c.req.text());
    const supplied = Buffer.from(form.get('csrf') || '');
    if (supplied.length !== csrf.length || !timingSafeEqual(supplied, Buffer.from(csrf))) return c.text('Invalid form token', 403);
    return form;
  }
  app.post('/notes', async (c) => {
    const form = await validateForm(c);
    if (form instanceof Response) return form;
    const note = form.get('text')?.trim();
    if (!note || note.length > 2000) return c.text('A note must contain 1–2000 characters', 400);
    const { rows } = await query(c, 'INSERT INTO notes (text) VALUES ($1) RETURNING id', [note]);
    c.header('X-Note-ID', String(rows[0].id));
    return c.redirect('/', 303);
  });
  app.post('/notes/:id/delete', async (c) => {
    const form = await validateForm(c);
    if (form instanceof Response) return form;
    if (!/^[1-9][0-9]{0,18}$/.test(c.req.param('id'))) return c.text('Invalid note ID', 400);
    await query(c, 'DELETE FROM notes WHERE id = $1', [c.req.param('id')]);
    return c.body(null, 204);
  });
  app.onError((_error, c) => c.text('Service temporarily unavailable', 503));
  return app;
}
