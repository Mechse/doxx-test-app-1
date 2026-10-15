import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { initializeDatabase } from '../../app/bootstrap.js';
const pg = createRequire(new URL('../../app/package.json', import.meta.url))('pg');
const run = promisify(execFile);
const bootstrap = new URL('../../app/bootstrap.js', import.meta.url).pathname;
test('bootstrap failures do not print AWS CLI secret output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'doxx-bootstrap-'));
  try {
    await writeFile(join(dir, 'aws'), '#!/bin/sh\necho fixture-master-secret >&2\nexit 1\n', { mode: 0o755 });
    await assert.rejects(run(process.execPath, [bootstrap], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DB_HOST: 'fixture', DB_SECRET_ARN: 'fixture', AWS_REGION: 'us-east-1', DB_CA_FILE: 'fixture' } }), error => {
      assert.match(error.stderr, /Database bootstrap failed/);
      assert.doesNotMatch(error.stderr, /fixture-master-secret/);
      return error.code === 1;
    });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
const localPostgres = process.env.RUN_LOCAL_POSTGRES_TESTS === '1' && ['initdb', 'pg_ctl'].every(command => spawnSync(command, ['--version']).status === 0);
test('the runtime DB role can use notes but cannot change schema or administer the database', { skip: !localPostgres }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'doxx-db-'));
  const data = join(dir, 'data');
  let started = false;
  const pools = [];
  const connect = (database, user) => {
    const pool = new pg.Pool({ host: dir, database, user, max: 1 });
    pools.push(pool);
    return pool;
  };
  try {
    await run('initdb', ['-D', data, '-U', 'bootstrap_admin', '--auth=trust', '--no-locale']);
    await run('pg_ctl', ['-D', data, '-l', join(dir, 'server.log'), '-o', `-c listen_addresses='' -k ${dir}`, '-w', 'start']);
    started = true;
    const clusterAdmin = connect('postgres', 'bootstrap_admin');
    await clusterAdmin.query('CREATE ROLE bootstrap_owner LOGIN CREATEROLE');
    await clusterAdmin.query('CREATE DATABASE notes OWNER bootstrap_owner');
    // PostgreSQL 14's public schema owner differs from RDS PostgreSQL 17's
    // pg_database_owner default. Give the test DB owner equivalent schema control.
    await connect('notes', 'bootstrap_admin').query('ALTER SCHEMA public OWNER TO bootstrap_owner');
    const admin = connect('notes', 'bootstrap_owner');
    await initializeDatabase(admin, "fixture'password");
    const app = connect('notes', 'notes_app');
    const { rows } = await app.query('INSERT INTO notes (text) VALUES ($1) RETURNING id', ['persist']);
    assert.equal((await app.query('SELECT text FROM notes WHERE id = $1', [rows[0].id])).rows[0].text, 'persist');
    for (const sql of ['DROP TABLE notes', 'ALTER TABLE notes ADD COLUMN forbidden text', "UPDATE notes SET text = 'forbidden'", 'TRUNCATE notes', 'CREATE TABLE forbidden (id int)', 'CREATE ROLE forbidden', 'CREATE DATABASE forbidden']) {
      await assert.rejects(app.query(sql), error => error.code === '42501');
    }
    await initializeDatabase(admin, 'rotated-fixture-password');
    assert.equal((await app.query('SELECT text FROM notes WHERE id = $1', [rows[0].id])).rows[0].text, 'persist');
    assert.equal((await app.query('DELETE FROM notes WHERE id = $1', [rows[0].id])).rowCount, 1);
    const role = (await admin.query("SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = 'notes_app'")).rows[0];
    assert.ok(Object.values(role).every(value => value === false));
  } finally {
    await Promise.allSettled(pools.map(pool => pool.end()));
    if (started) await run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    await rm(dir, { recursive: true, force: true });
  }
});
