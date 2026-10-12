import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../../app/app.js';
function fixture(remote = '10.1.0.1') {
  const calls = [];
  const pool = { query: async (sql, values) => { calls.push({ sql, values }); return { rows: sql.startsWith('SELECT id') ? [{ id: '1', text: '<script>alert(1)</script>', created_at: new Date(0) }] : [{ id: '2' }] }; } };
  return { calls, app: createApp({ pool, bindHost: '10.1.0.2', clientIp: '10.1.0.1', remoteAddress: () => remote }) };
}
const formRequest = (app, csrf, text, extra = {}) => app.request('http://10.1.0.2:8080/notes', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...extra }, body: new URLSearchParams({ csrf, text }) });
test('escapes database content and reports timings without trusting forwarded IPs', async () => {
  const { app } = fixture();
  const res = await app.request('/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /&lt;script&gt;/);
  assert.match(res.headers.get('server-timing'), /app;dur=[\d.]+, db;dur=[\d.]+/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});
test('rejects other peers even with a forged forwarded address', async () => {
  const { app, calls } = fixture('10.1.9.9');
  assert.equal((await app.request('/', { headers: { 'x-forwarded-for': '10.1.0.1' } })).status, 403);
  assert.equal(calls.length, 0);
});
test('notes require valid form token and same-origin browser requests', async () => {
  const { app, calls } = fixture();
  const html = await (await app.request('/')).text();
  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  assert.equal((await formRequest(app, '', 'bad')).status, 403);
  assert.equal((await formRequest(app, csrf, 'bad', { origin: 'https://attacker.example' })).status, 403);
  assert.equal((await formRequest(app, csrf, ' ')).status, 400);
  assert.equal((await formRequest(app, csrf, 'a'.repeat(2001))).status, 400);
  const response = await formRequest(app, csrf, "'; DROP TABLE notes; --");
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('x-note-id'), '2');
  assert.deepEqual(calls.at(-1).values, ["'; DROP TABLE notes; --"]);
  assert.match(calls.at(-1).sql, /VALUES \(\$1\)/);
});
test('body size and database errors are bounded and sanitized', async () => {
  const { app } = fixture();
  assert.equal((await formRequest(app, '', 'x'.repeat(9000))).status, 413);
  const broken = createApp({ pool: { query: async () => { throw new Error('secret password'); } }, clientIp: '10.1.0.1', remoteAddress: () => '10.1.0.1' });
  const res = await broken.request('/');
  assert.equal(res.status, 503);
  assert.doesNotMatch(await res.text(), /secret/);
});
test('cleanup only deletes the specified note with a valid form token', async () => {
  const { app, calls } = fixture();
  const csrf = (await (await app.request('/')).text()).match(/name="csrf" value="([^"]+)"/)[1];
  const res = await app.request('/notes/2/delete', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf }) });
  assert.equal(res.status, 204);
  assert.deepEqual(calls.at(-1), { sql: 'DELETE FROM notes WHERE id = $1', values: ['2'] });
});
