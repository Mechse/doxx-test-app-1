import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const actualScript = new URL('../../scripts/doxx.mjs', import.meta.url).pathname;
const fixtureModule = `
import fs from 'node:fs';
const path = process.env.MOCK_STATE;
export function read() { return JSON.parse(fs.readFileSync(path)); }
export function save(state) { fs.writeFileSync(path, JSON.stringify(state)); }
export function doxx(action, p) {
  const s = read(); s.calls.push(action);
  let response = {};
  if (action === 'servers') response = { servers: [{ server_name: 'wireguard.example.com' }] };
  else if (action === 'list_tunnels') response = { tunnels: s.tunnels };
  else if (action === 'create_tunnel') { if (p.type !== 'wireguard') throw new Error('Explicit WireGuard type required'); s.tunnels.push({ name: p.name, server: p.server, tunnel_token: 'fixture-app', assigned_ip: '10.1.0.2/31' }); }
  else if (action === 'wireguard') response = { config: { interface: { private_key: 'A'.repeat(43) + '=', address: '10.1.0.2/31' }, peer: { public_key: 'B'.repeat(43) + '=', endpoint: '198.51.100.8:51820' } } };
  else if (action === 'firewall_rule_list') response = { rules: s.rules.map(rule => ({ ...rule, dst_ip: rule.dst_ip.includes('/') ? rule.dst_ip : rule.dst_ip + '/32' })), link_all_enabled: s.linkAll || false };
  else if (action === 'firewall_rule_add') { const {token, firewall_rule_add, ...rule} = p; s.rules.push({ ...rule, enabled: 1 }); }
  else if (action === 'firewall_rule_delete') s.rules = s.rules.filter(r => r.src_ip !== p.src_ip);
  else if (action === 'delete_tunnel') s.tunnels = s.tunnels.filter(t => t.tunnel_token !== p.tunnel_token);
  else throw new Error('Unexpected mock API action');
  save(s); return {status: 'success', ...response};
}
globalThis.fetch = async (_url, options) => { const p = Object.fromEntries(options.body); const action = Object.keys(p)[0]; return { ok: true, status: 200, json: async () => doxx(action, p) }; };
`;
const fakeAws = `#!/usr/bin/env node
import fs from 'node:fs';
import { read, save } from './mock.mjs';
const args = process.argv.slice(2); const s = read(); let result = {};
if (args[0] === 'sts') result = {Account: '123456789012'};
else if (args[1] === 'describe-parameters') result = {Parameters: s.parameter ? [{Name: '/doxx-test-app/wg-conf'}] : []};
else if (args[1] === 'list-tags-for-resource') result = {TagList: s.parameter?.Tags || []};
else if (args[1] === 'put-parameter') { const file = args[args.indexOf('--cli-input-json') + 1].slice('file://'.length); if ((fs.statSync(file).mode & 0o777) !== 0o600) throw new Error('Unsafe request-file permissions'); const input = JSON.parse(fs.readFileSync(file, 'utf8')); s.parameter = {...input, Tags: input.Tags || s.parameter?.Tags}; }
else if (args[1] === 'delete-parameter') s.parameter = null;
else throw new Error('Unexpected AWS operation');
save(s); process.stdout.write(JSON.stringify(result));
`;
async function setup(borrowed = false, unownedParameter = false) {
  const dir = await mkdtemp(join(tmpdir(), 'doxx-test-'));
  await mkdir(join(dir, 'infra'));
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  await writeFile(join(dir, 'mock.mjs'), fixtureModule);
  await writeFile(join(dir, 'aws'), fakeAws, { mode: 0o755 });
  const initial = { calls: [], tunnels: [{ name: 'Mac', tunnel_token: 'fixture-mac', assigned_ip: '10.1.0.4/31' }], rules: [], parameter: unownedParameter ? {Tags: []} : null };
  if (borrowed) initial.tunnels.push({ name: 'aws-test-app', tunnel_token: 'fixture-app', server: 'wireguard.example.com', assigned_ip: '10.1.0.2/31' });
  await writeFile(join(dir, 'state.json'), JSON.stringify(initial));
  const execute = (action) => run(process.execPath, ['--import', join(dir, 'mock.mjs'), actualScript, action], { cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, DOXX_TOKEN: 'fixture-token-not-real', AWS_REGION: 'us-east-1', DOXX_TUNNEL_NAME: 'aws-test-app', WG_PARAMETER_NAME: '/doxx-test-app/wg-conf', DOXX_ALLOWED_IPS: '10.0.0.0/8', WG_MTU: '1380', DOXX_SERVER: 'wireguard.example.com', DEVICE_TUNNEL_NAME: 'Mac', MOCK_STATE: join(dir, 'state.json') } });
  return { dir, execute, state: async () => JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) };
}
test('provisioning is idempotent and teardown deletes only owned resources', async () => {
  const f = await setup();
  try {
    await f.execute('provision'); await f.execute('provision');
    assert.ok(!(await readdir(join(f.dir, '.local'))).some(name => name.startsWith('aws-input-')));
    let s = await f.state();
    assert.equal(s.calls.filter(x => x === 'create_tunnel').length, 1);
    assert.equal(s.calls.filter(x => x === 'firewall_rule_add').length, 1);
    assert.equal(s.parameter.Overwrite, true);
    const inputs = JSON.parse(await readFile(join(f.dir, 'infra/generated.auto.tfvars.json'), 'utf8'));
    assert.deepEqual(inputs.tunnel_endpoint_ips, ['198.51.100.8']);
    assert.equal(inputs.tunnel_endpoint_port, 51820);
    assert.match(s.parameter.Value, /Endpoint = 198\.51\.100\.8:51820/);
    await f.execute('teardown'); s = await f.state();
    assert.equal(s.tunnels.length, 1); assert.equal(s.tunnels[0].name, 'Mac');
    assert.equal(s.rules.length, 0); assert.equal(s.parameter, null);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
test('cleanup preserves a borrowed existing tunnel', async () => {
  const f = await setup(true);
  try { await f.execute('provision'); await f.execute('teardown'); assert.equal((await f.state()).tunnels.length, 2); }
  finally { await rm(f.dir, { recursive: true, force: true }); }
});
test('provisioning refuses an existing unowned SSM parameter', async () => {
  const f = await setup(true, true);
  try {
    await assert.rejects(f.execute('provision'), error => /Refusing to overwrite/.test(error.stderr));
    assert.deepEqual((await f.state()).parameter, { Tags: [] });
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
test('Link All is refused before any provisioning mutation', async () => {
  const f = await setup();
  try {
    await writeFile(join(f.dir, 'state.json'), JSON.stringify({ ...await f.state(), linkAll: true }));
    await assert.rejects(f.execute('provision'), error => /Link All must be disabled/.test(error.stderr));
    const state = await f.state();
    assert.equal(state.tunnels.length, 1);
    assert.equal(state.parameter, null);
    assert.ok(!state.calls.includes('create_tunnel'));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
test('a parked matching rule stops provisioning without replacing unowned resources', async () => {
  const f = await setup(true);
  try {
    const rules = [{ tunnel_token: 'fixture-app', protocol: 'TCP', src_ip: '10.1.0.4/32', src_port: 'ALL', dst_ip: '10.1.0.2', dst_port: '8080', enabled: 0 }];
    await writeFile(join(f.dir, 'state.json'), JSON.stringify({ ...await f.state(), rules }));
    await assert.rejects(f.execute('provision'), error => /firewall rule is disabled/.test(error.stderr));
    const state = await f.state();
    assert.deepEqual(state.rules, rules);
    assert.equal(state.parameter, null);
    assert.ok(!state.calls.includes('firewall_rule_add'));
    assert.ok(!state.calls.includes('firewall_rule_delete'));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
test('a parked project-owned rule is recreated as active', async () => {
  const f = await setup();
  try {
    await f.execute('provision');
    const state = await f.state();
    await writeFile(join(f.dir, 'state.json'), JSON.stringify({ ...state, rules: state.rules.map(rule => ({ ...rule, enabled: 0 })) }));
    await f.execute('provision');
    const repaired = await f.state();
    assert.equal(repaired.rules.length, 1);
    assert.equal(repaired.rules[0].enabled, 1);
    assert.equal(repaired.calls.filter(action => action === 'firewall_rule_delete').length, 1);
    assert.equal(repaired.calls.filter(action => action === 'firewall_rule_add').length, 2);
    assert.equal(JSON.parse(await readFile(join(f.dir, '.local/provision.json'), 'utf8')).rules.length, 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
