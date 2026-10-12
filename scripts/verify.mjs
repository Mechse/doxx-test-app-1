import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { api, aws } from './doxx.mjs';
const out = JSON.parse(execFileSync('terraform', ['-chdir=infra', 'output', '-json'], { encoding: 'utf8' }));
const value = (key) => out[key].value;
process.env.AWS_REGION = value('aws_region');
const url = value('app_url');
const request = (path, options = {}) => fetch(url + path, { redirect: 'manual', signal: AbortSignal.timeout(10000), ...options });
if (process.argv.includes('--offline')) {
  let failed = false;
  try { await request('/healthz'); } catch { failed = true; }
  assert.ok(failed, 'App is reachable while Mac tunnel is supposed to be disconnected');
  console.log('Offline check passed. Reconnect the Mac tunnel before other tests.');
} else {
  const appSg = (await aws(['ec2', 'describe-security-groups', '--group-ids', value('app_security_group_id')])).SecurityGroups[0];
  assert.equal(appSg.IpPermissions.length, 0, 'App SG must have zero ingress');
  const dbSg = (await aws(['ec2', 'describe-security-groups', '--group-ids', value('db_security_group_id')])).SecurityGroups[0];
  assert.equal(dbSg.IpPermissions.length, 1);
  const rule = dbSg.IpPermissions[0];
  assert.equal(rule.FromPort, 5432); assert.equal(rule.ToPort, 5432); assert.equal(rule.IpProtocol, 'tcp');
  assert.equal(rule.IpRanges.length + rule.Ipv6Ranges.length, 0);
  assert.equal(rule.UserIdGroupPairs.length, 1);
  assert.equal(rule.UserIdGroupPairs[0].GroupId, value('app_security_group_id'));
  const db = (await aws(['rds', 'describe-db-instances', '--db-instance-identifier', value('db_identifier')])).DBInstances[0];
  assert.equal(db.PubliclyAccessible, false);
  const state = JSON.parse(await readFile('.local/provision.json', 'utf8'));
  const tunnel = (await api('list_tunnels')).tunnels.find((t) => t.tunnel_token === state.tunnelToken);
  assert.equal(tunnel?.is_connected, true, 'App tunnel must be connected');
  const health = await request('/healthz'); assert.equal(health.status, 200);
  const page = await request('/'); assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes(value('client_ip')), 'Page must report the Mac tunnel IP');
  const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1]; assert.ok(csrf);
  const note = `verification-${randomUUID()}`;
  const post = await request('/notes', { method: 'POST', body: new URLSearchParams({ csrf, text: note }) });
  assert.equal(post.status, 303);
  const id = post.headers.get('x-note-id'); assert.match(id, /^\d+$/);
  try {
    const command = await aws(['ssm', 'send-command', '--document-name', 'AWS-RunShellScript', '--instance-ids', value('instance_id'), '--parameters', JSON.stringify({ commands: ['systemctl restart doxx-app.service'] })]);
    let succeeded = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      await sleep(2000);
      const result = await aws(['ssm', 'list-command-invocations', '--command-id', command.Command.CommandId, '--details']);
      const invocation = result.CommandInvocations[0];
      if (invocation?.Status === 'Success') { succeeded = true; break; }
      if (['Failed', 'Cancelled', 'TimedOut'].includes(invocation?.Status)) throw new Error('App restart failed');
    }
    assert.ok(succeeded, 'App restart timed out');
    let recovered = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { const res = await request('/'); if (res.status === 200 && (await res.text()).includes(note)) { recovered = true; break; } } catch {}
      await sleep(2000);
    }
    assert.ok(recovered, 'Note did not survive restart');
  } finally {
    const fresh = await (await request('/')).text();
    const freshToken = fresh.match(/name="csrf" value="([^"]+)"/)?.[1];
    assert.equal((await request(`/notes/${id}/delete`, { method: 'POST', body: new URLSearchParams({ csrf: freshToken }) })).status, 204);
  }
  let blocked = false;
  try { await fetch(`http://${value('public_ip')}:8080/healthz`, { signal: AbortSignal.timeout(5000) }); } catch { blocked = true; }
  assert.ok(blocked, 'Public app port unexpectedly reachable');
  console.log('Online checks passed: private app, isolated database, caller IP, and persistence after restart.');
  console.log('Manual remaining check: disconnect your Mac tunnel, run make verify-offline, then reconnect.');
}
