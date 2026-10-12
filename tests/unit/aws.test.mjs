import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { aws, safeAwsError } from '../../scripts/doxx.mjs';
const hasAws = spawnSync('aws', ['--version']).status === 0;
test('real AWS CLI accepts private JSON file without any AWS request', { skip: !hasAws }, async () => {
  const before = (await readdir('.local').catch(() => [])).filter(n => n.startsWith('aws-input-'));
  const result = await aws(['ssm', 'put-parameter', '--generate-cli-skeleton', 'output'], {
    Name: '/local-validation-only', Type: 'SecureString', Value: 'non-secret-fixture'
  });
  assert.equal(typeof result.Version, 'number');
  assert.deepEqual((await readdir('.local')).filter(n => n.startsWith('aws-input-')), before);
});
test('private request file is removed when AWS CLI validation fails', { skip: !hasAws }, async () => {
  const before = (await readdir('.local').catch(() => [])).filter(n => n.startsWith('aws-input-'));
  await assert.rejects(aws(['ssm', 'put-parameter', '--generate-cli-skeleton', 'output'], { UnexpectedFixtureField: 'never-echo-this' }), error => {
    assert.doesNotMatch(error.message, /never-echo-this/);
    return true;
  });
  assert.deepEqual((await readdir('.local')).filter(n => n.startsWith('aws-input-')), before);
});
test('AWS errors expose actionable categories without stderr secrets', () => {
  assert.match(safeAwsError('An error occurred (AccessDeniedException) when calling the PutParameter operation: private-account-information'), /AccessDeniedException: Check IAM/);
  assert.doesNotMatch(safeAwsError('Error parsing parameter: {"Value":"private-key-content"}'), /private-key-content/);
  assert.doesNotMatch(safeAwsError('unknown error with a secret'), /with a secret/);
});
