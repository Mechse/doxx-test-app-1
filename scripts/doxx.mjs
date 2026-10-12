import { readFile, writeFile, mkdir, rename, unlink, mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isIPv4, isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const statePath = '.local/provision.json';
const API = 'https://config.doxx.net/v1/';
export function safeApiError(data, secrets = []) {
  // Only diagnostic fields are eligible; never print response context/config.
  const sensitive = [...secrets];
  function collect(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (/token|private.?key|password|secret|authorization/i.test(key) && typeof child === 'string') sensitive.push(child);
      else if (child && typeof child === 'object') collect(child);
    }
  }
  collect(data);
  const parts = [data?.error_code, data?.message, typeof data?.error === 'string' ? data.error : undefined].filter((v) => typeof v === 'string');
  let message = parts.join(': ');
  for (const secret of sensitive.filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (const variant of [secret, encodeURIComponent(secret), new URLSearchParams({ v: secret }).toString().slice(2)]) message = message.split(variant).join('[redacted]');
  }
  message = message
    .replace(/(?:https?:\/\/)[^\s<>]+/gi, '[URL omitted]')
    .replace(/((?:token|private[_ -]?key|password|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .replace(/[A-Za-z0-9+/_=-]{32,}/g, '[redacted]')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .slice(0, 500);
  return message || 'No safe diagnostic message returned';
}
export async function api(action, fields = {}, auth = true) {
  if (auth && !process.env.DOXX_TOKEN) throw new Error('Set DOXX_TOKEN in your environment or private .env file');
  const body = new URLSearchParams({ [action]: '1', ...fields, ...(auth ? { token: process.env.DOXX_TOKEN } : {}) });
  const response = await fetch(API, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(30000) });
  let data;
  try { data = await response.json(); } catch { throw new Error(`doxx ${action}: invalid response (body suppressed)`); }
  if (!response.ok || data.status !== 'success') throw new Error(`doxx ${action} failed (HTTP ${response.status}): ${safeApiError(data, [process.env.DOXX_TOKEN, ...Object.entries(fields).filter(([key]) => /token|key|password|secret/i.test(key)).map(([, value]) => value)])}`);
  return data;
}
export function safeAwsError(stderr) {
  // Do not echo CLI stderr: parse failures may include the complete secret JSON.
  const code = String(stderr).match(/An error occurred \(([A-Za-z][A-Za-z0-9]{0,63})\) when calling/)?.[1];
  const hints = {
    AccessDeniedException: 'Check IAM permission for this AWS operation and any KMS key involved.',
    AccessDenied: 'Check IAM permission for this AWS operation.',
    ParameterAlreadyExists: 'The parameter already exists; check project ownership before overwriting.',
    ParameterNotFound: 'The requested parameter does not exist in this region.',
    ExpiredToken: 'Refresh your AWS credentials and retry.',
    ExpiredTokenException: 'Refresh your AWS credentials and retry.',
    UnrecognizedClientException: 'Check your active AWS credentials.',
    ValidationException: 'AWS rejected the request parameters.',
    ThrottlingException: 'AWS rate limit reached; retry later.'
  };
  if (code) return `${code}: ${hints[code] || 'AWS rejected the operation; raw details withheld to protect secrets.'}`;
  if (/Unable to load paramfile/i.test(stderr)) return 'AWS CLI could not read the private request file.';
  if (/Unable to locate credentials/i.test(stderr)) return 'AWS credentials are unavailable.';
  if (/Could not connect to the endpoint URL/i.test(stderr)) return 'Cannot reach the AWS endpoint; check network and region.';
  if (/Parameter validation failed|Error parsing parameter/i.test(stderr)) return 'AWS CLI request validation failed; input withheld to protect secrets.';
  return 'AWS CLI failed; raw details withheld to protect secrets.';
}
export async function aws(args, input) {
  // Node subprocess stdin is not a reopenable file on every platform (notably
  // macOS). Use a 0700 directory / 0600 file, never secret command arguments.
  let privateDir;
  try {
    const cliArgs = [...args];
    if (input !== undefined) {
      await mkdir('.local', { recursive: true, mode: 0o700 });
      privateDir = await mkdtemp(resolve('.local/aws-input-'));
      const path = `${privateDir}/request.json`;
      await writeFile(path, JSON.stringify(input), { mode: 0o600, flag: 'wx' });
      cliArgs.push('--cli-input-json', `file://${path}`);
    }
    cliArgs.push('--region', process.env.AWS_REGION || 'us-east-1', '--output', 'json', '--no-cli-pager');
    const stdout = await new Promise((resolveOutput, reject) => {
      const child = execFile('aws', cliArgs, { timeout: 60000, maxBuffer: 2 * 1024 * 1024 }, (error, out, stderr) => {
        if (error) {
          const detail = error.code === 'ENOENT' ? 'AWS CLI executable not found.' : error.killed ? 'AWS CLI timed out.' : safeAwsError(stderr);
          reject(new Error(`AWS ${args[0]} ${args[1]} failed: ${detail}`));
        } else resolveOutput(out);
      });
      child.stdin.on('error', () => {});
      child.stdin.end();
    });
    try { return stdout.trim() ? JSON.parse(stdout) : {}; }
    catch { throw new Error('Invalid AWS response (body withheld)'); }
  } finally {
    if (privateDir) await rm(privateDir, { recursive: true, force: true });
  }
}
export const ipv4 = (value) => {
  const ip = String(value || '').split('/')[0];
  if (!isIPv4(ip) || !ip.startsWith('10.')) throw new Error('Expected a doxx 10.x IPv4 address');
  return ip;
};
export function renderWireguard(config, allowed, mtu) {
  const { interface: iface, peer } = config || {};
  const key = /^[A-Za-z0-9+/]{43}=$/;
  if (!key.test(iface?.private_key || '') || !key.test(peer?.public_key || '')) throw new Error('Invalid WireGuard key schema');
  const addresses = String(iface.address || '').split(',').map((s) => s.trim());
  for (const addr of addresses) {
    const [ip, prefix] = addr.split('/');
    if (!isIP(ip) || !/^\d+$/.test(prefix || '') || +prefix > (isIP(ip) === 4 ? 32 : 128)) throw new Error('Invalid tunnel address');
  }
  const ranges = allowed.split(',').map((s) => s.trim());
  for (const range of ranges) {
    const [ip, prefix] = range.split('/');
    if (!isIP(ip) || !/^\d+$/.test(prefix || '') || +prefix > (isIP(ip) === 4 ? 32 : 128)) throw new Error('Invalid split-tunnel CIDR');
    if (isIP(ip) === 4 ? (!ip.startsWith('10.') || +prefix < 8) : (!ip.toLowerCase().startsWith('2602:f5c1:1:') || +prefix < 48)) throw new Error('Routes must stay within documented doxx ranges');
  }
  if (!/^[a-zA-Z0-9.-]+:\d{1,5}$/.test(peer.endpoint || '') || !Number.isInteger(+mtu) || +mtu < 1280 || +mtu > 1420) throw new Error('Invalid endpoint or MTU');
  return `[Interface]\nPrivateKey = ${iface.private_key}\nAddress = ${addresses.join(', ')}\nMTU = ${mtu}\n\n[Peer]\nPublicKey = ${peer.public_key}\nEndpoint = ${peer.endpoint}\nAllowedIPs = ${ranges.join(', ')}\nPersistentKeepalive = 25\n`;
}
async function save(state) {
  await mkdir('.local', { recursive: true, mode: 0o700 });
  await writeFile(`${statePath}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(`${statePath}.tmp`, statePath);
}
async function load() {
  try { return JSON.parse(await readFile(statePath, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
const one = (tunnels, name) => {
  const matches = tunnels.filter((t) => t.name === name);
  if (matches.length > 1) throw new Error(`Multiple tunnels match ${name}; choose a unique name`);
  return matches[0];
};
async function provision() {
  const env = process.env;
  const name = env.DOXX_TUNNEL_NAME || 'aws-test-app';
  if (!env.DEVICE_TUNNEL_NAME || !env.DOXX_SERVER) throw new Error('Set DEVICE_TUNNEL_NAME and DOXX_SERVER first');
  if (name === env.DEVICE_TUNNEL_NAME) throw new Error('App and Mac tunnels must be different');
  const region = env.AWS_REGION || 'us-east-1';
  const parameter = env.WG_PARAMETER_NAME || '/doxx-test-app/wg-conf';
  const account = (await aws(['sts', 'get-caller-identity'])).Account;
  let state = await load();
  if (state && (state.account !== account || state.region !== region || state.name !== name || state.parameter !== parameter)) throw new Error('Configuration differs from ownership journal; finish cleanup before changing it');
  const servers = await api('servers', {}, false);
  if (!servers.servers.some((s) => s.server_name === env.DOXX_SERVER)) throw new Error('DOXX_SERVER is not in server discovery');
  let tunnels = (await api('list_tunnels')).tunnels;
  const mac = one(tunnels, env.DEVICE_TUNNEL_NAME);
  if (!mac) throw new Error('Selected Mac tunnel not found');
  const clientIp = ipv4(mac.assigned_ip);
  let tunnel = one(tunnels, name);
  if (tunnel && tunnel.server !== env.DOXX_SERVER) throw new Error('Existing app tunnel uses another server; refusing to migrate it');
  if (!state) {
    state = { owner: randomUUID(), account, region, name, parameter, tunnelOwned: false, parameterOwned: false, rules: [] };
    await save(state);
  }
  if (state.tunnelToken && tunnel?.tunnel_token !== state.tunnelToken) throw new Error('App tunnel changed outside this project; refusing to modify it');
  if (!tunnel) {
    await api('create_tunnel', { name, server: env.DOXX_SERVER, type: 'wireguard' });
    tunnels = (await api('list_tunnels')).tunnels;
    tunnel = one(tunnels, name);
    if (!tunnel) throw new Error('Created tunnel not found; inspect account before retrying');
    state.tunnelOwned = true;
  }
  state.tunnelToken = tunnel.tunnel_token;
  state.tunnelIp = ipv4(tunnel.assigned_ip);
  await save(state);
  const wg = await api('wireguard', { tunnel_token: tunnel.tunnel_token });
  if (ipv4(wg.config?.interface?.address?.split(',')[0]) !== state.tunnelIp) throw new Error('WireGuard address differs from tunnel address');
  const value = renderWireguard(wg.config, env.DOXX_ALLOWED_IPS || '10.0.0.0/8,2602:f5c1:1::/48', env.WG_MTU || '1380');
  const existing = await aws(['ssm', 'describe-parameters', '--parameter-filters', `Key=Name,Option=Equals,Values=${parameter}`]);
  if (existing.Parameters.length) {
    const tags = await aws(['ssm', 'list-tags-for-resource', '--resource-type', 'Parameter', '--resource-id', parameter]);
    if (!tags.TagList.some((t) => t.Key === 'doxx-test-owner' && t.Value === state.owner)) throw new Error('Refusing to overwrite an SSM parameter not owned by this project');
  }
  await aws(['ssm', 'put-parameter'], { Name: parameter, Type: 'SecureString', Value: value, ...(existing.Parameters.length ? { Overwrite: true } : { Tags: [{ Key: 'doxx-test-owner', Value: state.owner }] }) });
  state.parameterOwned = true;
  await save(state);
  const rules = await api('firewall_rule_list', { tunnel_token: tunnel.tunnel_token });
  const desired = { tunnel_token: tunnel.tunnel_token, protocol: 'TCP', src_ip: `${clientIp}/32`, src_port: 'ALL', dst_ip: state.tunnelIp, dst_port: '8080' };
  if (!rules.link_all_enabled && !(rules.rules || []).some((r) => Object.entries(desired).every(([k, v]) => String(r[k]) === v))) {
    await api('firewall_rule_add', desired);
    state.rules.push(desired);
    await save(state);
  }
  // Remove only stale rules created by this project when changing the selected Mac.
  for (const rule of [...state.rules]) {
    if (rule.src_ip !== desired.src_ip) {
      await api('firewall_rule_delete', rule);
      state.rules = state.rules.filter((r) => r !== rule);
      await save(state);
    }
  }
  state.clientIp = clientIp;
  await save(state);
  await writeFile('infra/generated.auto.tfvars.json', JSON.stringify({ tunnel_ip: state.tunnelIp, client_ip: clientIp, aws_region: region, wg_parameter_name: parameter }, null, 2), { mode: 0o600 });
  console.log('Provisioning complete. Private deployment inputs written; run make deploy next.');
}
async function teardown() {
  const state = await load();
  if (!state) throw new Error('No ownership journal; refusing untracked deletion');
  if ((await aws(['sts', 'get-caller-identity'])).Account !== state.account || (process.env.AWS_REGION || 'us-east-1') !== state.region) throw new Error('AWS account or region differs from ownership journal');
  const tunnels = (await api('list_tunnels')).tunnels;
  const tunnel = tunnels.find((t) => t.tunnel_token === state.tunnelToken);
  if (tunnel) {
    const current = await api('firewall_rule_list', { tunnel_token: state.tunnelToken });
    for (const rule of [...state.rules]) {
      if (current.rules.some((r) => Object.entries(rule).every(([k, v]) => String(r[k]) === v))) await api('firewall_rule_delete', rule);
      state.rules = state.rules.filter((r) => r !== rule);
      await save(state);
    }
    if (state.tunnelOwned) await api('delete_tunnel', { tunnel_token: state.tunnelToken });
  }
  if (state.parameterOwned) {
    const existing = await aws(['ssm', 'describe-parameters', '--parameter-filters', `Key=Name,Option=Equals,Values=${state.parameter}`]);
    if (existing.Parameters.length) {
      const tags = await aws(['ssm', 'list-tags-for-resource', '--resource-type', 'Parameter', '--resource-id', state.parameter]);
      if (!tags.TagList.some((t) => t.Key === 'doxx-test-owner' && t.Value === state.owner)) throw new Error('SSM parameter ownership changed; refusing deletion');
      await aws(['ssm', 'delete-parameter', '--name', state.parameter]);
    }
  }
  await unlink(statePath);
  await unlink('infra/generated.auto.tfvars.json').catch((e) => { if (e.code !== 'ENOENT') throw e; });
  console.log('Project-owned doxx resources and WireGuard parameter removed.');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const action = process.argv[2];
    if (action === 'provision') await provision();
    else if (action === 'teardown') await teardown();
    else if (action === 'servers') console.log(JSON.stringify((await api('servers', {}, false)).servers.map(({ server_name, location }) => ({ server_name, location })), null, 2));
    else if (action === 'tunnels') console.log(JSON.stringify((await api('list_tunnels')).tunnels.map(({ name, is_connected }) => ({ name, is_connected })), null, 2));
    else throw new Error('Expected provision, teardown, servers, or tunnels');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
