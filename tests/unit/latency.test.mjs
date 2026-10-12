import test from 'node:test';
import assert from 'node:assert/strict';
import { percentile, stats } from '../latency/lib.mjs';
test('nearest-rank percentiles preserve input and handle empty data', () => {
  assert.equal(percentile([], 95), null);
  const values = [9, 1, 5, 2];
  assert.deepEqual(stats(values), { count: 4, p50: 2, p95: 9, p99: 9 });
  assert.deepEqual(values, [9, 1, 5, 2]);
});
import { renderReport } from '../../scripts/latency-report.mjs';
test('report generates four SVGs and matching tables without a deployed baseline', () => {
  const data = { schemaVersion: 1, timestamp: 'fixture', transport: 'test', region: 'test', provisional: true, cases: { tcp: { count: 2, p50: 1, p95: 2, p99: 2, samples: [1, 2] } }, kpis: { K1: { measured: 1, target: null, pass: true } }, timeline: [] };
  for (const dark of [false, true]) {
    const { charts, markdown } = renderReport(data, dark);
    assert.equal(Object.keys(charts).length, 4);
    Object.values(charts).forEach((svg) => { assert.match(svg, /^<svg/); assert.doesNotMatch(svg, /NaN|undefined/); });
    assert.match(markdown, /\| tcp \| 2 \| 1.00 \| 2.00/);
  }
});
