import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { chmod, chown, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const run = promisify(execFile);
export async function initializeDatabase(pool, password) {
  await pool.query('CREATE TABLE IF NOT EXISTS notes (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, text varchar(2000) NOT NULL, created_at timestamptz NOT NULL DEFAULT now())');
  await pool.query("DO $do$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'notes_app') THEN CREATE ROLE notes_app LOGIN; END IF; END $do$");
  // RDS administrators cannot ALTER superuser/replication flags, even to disable them.
  // New roles are unprivileged by default; verify flags before assigning a password.
  const { rows: roles } = await pool.query("SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = 'notes_app'");
  if (!roles[0] || Object.values(roles[0]).some(Boolean)) throw new Error('Unexpected application role privileges');
  const { rows } = await pool.query("SELECT format('ALTER ROLE notes_app WITH LOGIN PASSWORD %L', $1::text) AS statement", [password]);
  await pool.query(rows[0].statement);
  await pool.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await pool.query('REVOKE ALL ON SCHEMA public FROM notes_app');
  await pool.query('GRANT CONNECT ON DATABASE notes TO notes_app');
  await pool.query('GRANT USAGE ON SCHEMA public TO notes_app');
  await pool.query('REVOKE ALL ON TABLE notes FROM notes_app');
  await pool.query('GRANT SELECT, INSERT, DELETE ON TABLE notes TO notes_app');
  await pool.query('REVOKE ALL ON SEQUENCE notes_id_seq FROM notes_app');
  await pool.query('GRANT USAGE, SELECT ON SEQUENCE notes_id_seq TO notes_app');
}

async function bootstrap() {
  const { DB_HOST, DB_SECRET_ARN, AWS_REGION, DB_CA_FILE } = process.env;
  const credentialsPath = '/run/doxx-app/db-credentials.json';
  let pool;
  let phase = 'configuration';
  try {
    if (![DB_HOST, DB_SECRET_ARN, AWS_REGION, DB_CA_FILE].every(Boolean)) throw new Error('Missing database bootstrap configuration');
    phase = 'managed secret retrieval';
    const { stdout } = await run('aws', ['secretsmanager', 'get-secret-value', '--secret-id', DB_SECRET_ARN, '--region', AWS_REGION, '--output', 'json', '--no-cli-pager'], { timeout: 30000 });
    const master = JSON.parse(JSON.parse(stdout).SecretString);
    const password = randomBytes(32).toString('base64url');
    phase = 'database initialization';
    pool = new pg.Pool({ host: DB_HOST, port: 5432, database: 'notes', user: master.username, password: master.password,
      ssl: { ca: await readFile(DB_CA_FILE, 'utf8'), rejectUnauthorized: true }, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    await initializeDatabase(pool, password);
    phase = 'runtime credential file setup';
    await mkdir('/run/doxx-app', { recursive: true, mode: 0o750 });
    const { stdout: groupId } = await run('id', ['-g', 'notes']);
    await chown('/run/doxx-app', 0, Number(groupId.trim()));
    await chmod('/run/doxx-app', 0o750);
    const temporary = `${credentialsPath}.tmp`;
    await writeFile(temporary, JSON.stringify({ username: 'notes_app', password }), { mode: 0o600 });
    await chown(temporary, 0, Number(groupId.trim()));
    await chmod(temporary, 0o640);
    await rename(temporary, credentialsPath);
  } catch (error) {
    const code = typeof error.code === 'string' && /^[A-Z0-9_]{2,32}$/.test(error.code) ? ` (${error.code})` : '';
    console.error(`Database bootstrap failed during ${phase}${code}; credential details suppressed`);
    process.exitCode = 1;
  } finally {
    await pool?.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await bootstrap();
