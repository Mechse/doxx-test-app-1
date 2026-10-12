import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
export function deployment() {
  const out = JSON.parse(execFileSync('terraform', ['-chdir=infra', 'output', '-json'], { encoding: 'utf8' }));
  return Object.fromEntries(Object.entries(out).map(([key, output]) => [key, output.value]));
}
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p / 100 * sorted.length) - 1)];
}
export const stats = (values) => ({ count: values.length, p50: percentile(values, 50), p95: percentile(values, 95), p99: percentile(values, 99) });
export function connect(host, port) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const socket = net.connect({ host, port });
    socket.setTimeout(10000);
    socket.once('connect', () => { socket.destroy(); resolve(performance.now() - start); });
    socket.once('error', (error) => { socket.destroy(); reject(error); });
    socket.once('timeout', () => { socket.destroy(); reject(new Error('TCP timeout')); });
  });
}
export function request(url, { agent = false, method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const encoded = body ? new URLSearchParams(body).toString() : undefined;
    const req = http.request(url, { agent, method, headers: encoded ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(encoded) } : {} }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (part) => { text += part; });
      res.on('error', reject);
      res.on('end', () => {
        const timing = Object.fromEntries([...String(res.headers['server-timing'] || '').matchAll(/(app|db);dur=([\d.]+)/g)].map((m) => [m[1], +m[2]]));
        if (!timing.app && timing.app !== 0 || !timing.db && timing.db !== 0) return reject(new Error('Missing Server-Timing'));
        resolve({ ms: performance.now() - start, status: res.statusCode, timing, text, id: res.headers['x-note-id'] });
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('HTTP timeout')));
    req.on('error', reject);
    req.end(encoded);
  });
}
export { http };
