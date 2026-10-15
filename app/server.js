import { serve } from '@hono/node-server';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { isIPv4 } from 'node:net';
import { createApp } from './app.js';

const { BIND_HOST, CLIENT_IP, DB_HOST, DB_CREDENTIALS_FILE, DB_CA_FILE } = process.env;
if (!isIPv4(BIND_HOST || '') || !BIND_HOST.startsWith('10.') || !isIPv4(CLIENT_IP || '') || !CLIENT_IP.startsWith('10.')) {
  throw new Error('Explicit doxx IPv4 BIND_HOST and CLIENT_IP are required');
}
if (![DB_HOST, DB_CREDENTIALS_FILE, DB_CA_FILE].every(Boolean)) throw new Error('Missing database configuration');
let pool;
try {
  const credentials = JSON.parse(await readFile(DB_CREDENTIALS_FILE, 'utf8'));
  pool = new pg.Pool({ host: DB_HOST, port: 5432, database: 'notes', user: credentials.username, password: credentials.password,
    ssl: { ca: await readFile(DB_CA_FILE, 'utf8'), rejectUnauthorized: true }, max: 12, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  pool.on('error', () => console.error('Database connection failed'));
  await pool.query('SELECT 1');
} catch {
  console.error('Database initialization failed; check private service diagnostics');
  process.exit(1);
}
const server = serve({ fetch: createApp({ pool, bindHost: BIND_HOST, clientIp: CLIENT_IP }).fetch, hostname: BIND_HOST, port: 8080 });
server.on('error', () => { console.error('HTTP listener failed'); process.exit(1); });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  server.close(async () => { await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
});
