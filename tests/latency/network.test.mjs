import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolve4 } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { deployment, stats, connect, request, http } from './lib.mjs';
const cfg = JSON.parse(await readFile(new URL('./thresholds.json', import.meta.url)));
test('Private HTTP latency suite (live deployment required)', async (t) => {
  assert.equal(process.env.DIRECT_BASELINE_CONFIRMED, '1', 'Verify the regional baseline bypasses the Mac tunnel, then set DIRECT_BASELINE_CONFIRMED=1');
  const d = deployment();
  const [baselineIp] = await resolve4(`ec2.${d.aws_region}.amazonaws.com`);
  const base = d.app_url;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const results = { schemaVersion: 1, timestamp: new Date().toISOString(), transport: 'http-over-wireguard', region: d.aws_region, provisional: true, failures: 0, cases: {}, kpis: {}, timeline: [] };
  const kpi = (name, measured, target = null) => { results.kpis[name] = { measured, target, pass: target === null || measured <= target }; if (target !== null) assert.ok(measured <= target, `${name}: ${measured.toFixed(2)} > ${target.toFixed(2)} ms`); };
  async function sample(name, fn, field = (r) => r.ms) {
    const rows = [];
    for (let i = 0; i < cfg.samples + cfg.warmup; i++) {
      try { const row = await fn(); if (i >= cfg.warmup) rows.push(row); }
      catch { results.failures++; }
    }
    const values = rows.map(field);
    const result = { ...stats(values), samples: values };
    if (rows[0]?.timing) result.breakdown = { app: stats(rows.map((r) => r.timing.app)), db: stats(rows.map((r) => r.timing.db)), network: stats(rows.map((r) => Math.max(0, r.ms - r.timing.app - r.timing.db))) };
    results.cases[name] = result;
    assert.equal(rows.length, cfg.samples, `${name} had failures`);
    return result;
  }
  const get = async (path, options) => { const r = await request(base + path, options); assert.equal(r.status, 200); return r; };
  try {
    await t.test('TC-L1 TCP RTT', async () => {
      const r = await sample('tcp', () => connect(d.tunnel_ip, 8080), (v) => v);
      kpi('K1', r.p50); kpi('K3', r.p95 - r.p50, cfg.jitterMs);
    });
    await t.test('TC-L2 regional baseline', async () => {
      const r = await sample('direct', () => connect(baselineIp, 443), (v) => v);
      kpi('K2', results.cases.tcp.p50 - r.p50, cfg.overlayMs);
    });
    await t.test('TC-L3 warm health requests', async () => {
      const r = await sample('warm', () => get('/healthz', { agent }));
      kpi('K5', r.p95, results.cases.tcp.p95 + cfg.warmExtraMs);
      kpi('K7', r.breakdown.app.p95, cfg.appMs);
    });
    await t.test('TC-L4 cold health requests', async () => {
      const r = await sample('cold', () => get('/healthz'));
      kpi('K6', r.p95, 2 * results.cases.tcp.p95 + cfg.coldExtraMs);
    });
    await t.test('TC-L5 database read', async () => {
      const r = await sample('read', () => get('/', { agent }));
      kpi('K8', r.breakdown.db.p95, cfg.dbReadMs);
    });
    await t.test('TC-L6 database writes', async () => {
      const csrf = (await get('/')).text.match(/name="csrf" value="([^"]+)"/)[1];
      const r = await sample('write', async () => {
        const row = await request(base + '/notes', { agent, method: 'POST', body: { csrf, text: `latency-${randomUUID()}` } });
        assert.equal(row.status, 303); assert.match(row.id, /^\d+$/);
        const cleanup = await request(base + `/notes/${row.id}/delete`, { agent, method: 'POST', body: { csrf } });
        assert.equal(cleanup.status, 204);
        return row;
      });
      kpi('K9', r.breakdown.db.p95, cfg.dbWriteMs);
    });
    await t.test('TC-L7 concurrent load', async () => {
      const start = performance.now(); const rows = []; const buckets = new Map();
      await Promise.all(Array.from({ length: cfg.concurrency }, async () => {
        const client = new http.Agent({ keepAlive: true, maxSockets: 1 });
        try {
          while (performance.now() - start < cfg.loadSeconds * 1000) {
            try { const row = await get('/', { agent: client }); rows.push(row.ms); const second = Math.floor((performance.now() - start) / 1000); if (!buckets.has(second)) buckets.set(second, []); buckets.get(second).push(row.ms); }
            catch { results.failures++; }
          }
        } finally { client.destroy(); }
      }));
      results.cases.load = stats(rows);
      results.timeline = [...buckets].sort((a, b) => a[0] - b[0]).map(([second, values]) => ({ second, ...stats(values) }));
      assert.ok(rows.length > 0);
      kpi('K10', results.cases.load.p95, results.cases.read.p95 * cfg.loadMultiplier);
    });
    await t.test('TC-L8 after idle', async () => {
      agent.destroy(); await sleep(cfg.idleSeconds * 1000);
      try { const r = await get('/healthz'); results.cases.idle = stats([r.ms]); kpi('K11', r.ms, 2 * results.cases.tcp.p95 + cfg.coldExtraMs); }
      catch (error) { results.failures++; throw error; }
    });
    await t.test('K4 no failures', () => kpi('K4', results.failures, 0));
  } finally {
    agent.destroy();
    await mkdir('results', { recursive: true });
    const path = `results/latency-${results.timestamp.replace(/[:.]/g, '-')}.json`;
    await writeFile(path, JSON.stringify(results, null, 2));
    console.log(`Sanitized measurements written to ${path}; review before promoting to baseline.json.`);
  }
});
