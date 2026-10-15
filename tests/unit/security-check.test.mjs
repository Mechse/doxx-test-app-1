import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const scanner = new URL('../../scripts/security-check.mjs', import.meta.url).pathname;
test('the publishable baseline is scanned and diagnostics suppress secret values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'doxx-scan-'));
  const token = 'fixture-sensitive-token-for-scan';
  try {
    await mkdir(join(dir, 'results'));
    await writeFile(join(dir, '.env'), `DOXX_TOKEN=${token}`);
    await writeFile(join(dir, 'results/baseline.json'), JSON.stringify({ accidentalToken: token }));
    await assert.rejects(run(process.execPath, [scanner], { cwd: dir, env: { ...process.env, DOXX_TOKEN: token } }), error => {
      assert.match(error.stderr, /results\/baseline\.json/);
      assert.ok(!error.stderr.includes(token));
      return error.code === 1;
    });
    await writeFile(join(dir, 'results/baseline.json'), JSON.stringify({ samples: [1, 2, 3] }));
    assert.match((await run(process.execPath, [scanner], { cwd: dir, env: { ...process.env, DOXX_TOKEN: token } })).stdout, /scan passed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
