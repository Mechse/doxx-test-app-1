import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWireguard, ipv4, ruleEnabled, matchesRule } from '../../scripts/doxx.mjs';
const config = { interface: { private_key: 'A'.repeat(43) + '=', address: '10.1.0.2/31, 2602:f5c1:1::2/127' }, peer: { public_key: 'B'.repeat(43) + '=', endpoint: 'wireguard.example.com:51820' } };
test('WireGuard rendering omits DNS and default routes, preserving host addresses', () => {
  const result = renderWireguard(config, '10.0.0.0/8,2602:f5c1:1::/48', 1380);
  assert.match(result, /Address = 10.1.0.2\/31/);
  assert.match(result, /PersistentKeepalive = 25/);
  assert.doesNotMatch(result, /DNS|0\.0\.0\.0\/0|::\/0/);
});
test('rejects injected config, invalid addresses and full-tunnel routes', () => {
  assert.throws(() => renderWireguard({ ...config, peer: { ...config.peer, endpoint: 'host:51820\nPostUp = malicious' } }, '10.0.0.0/8', 1380));
  assert.throws(() => renderWireguard(config, '0.0.0.0/0', 1380));
  assert.throws(() => renderWireguard({ ...config, peer: { ...config.peer, endpoint: 'host:65536' } }, '10.0.0.0/8', 1380));
  assert.throws(() => ipv4('0.0.0.0'));
  assert.equal(ipv4('10.1.0.3/31'), '10.1.0.3');
});
test('parked rule flags are never accepted as active', () => {
  for (const enabled of [false, 0, '0', null, 'false']) assert.equal(ruleEnabled({ enabled }), false);
  for (const enabled of [true, 1, '1', undefined]) assert.equal(ruleEnabled({ enabled }), true);
});
test('firewall rule matching recognizes host CIDRs without broadening the source or destination', () => {
  const desired = { src_ip: '10.1.0.4/32', dst_ip: '10.1.0.2', protocol: 'TCP', dst_port: '8080' };
  assert.equal(matchesRule({ ...desired, src_ip: '10.1.0.4', dst_ip: '10.1.0.2/32' }, desired), true);
  assert.equal(matchesRule({ ...desired, src_ip: '10.1.0.4/24' }, desired), false);
  assert.equal(matchesRule({ ...desired, dst_ip: '10.1.0.3/32' }, desired), false);
});
import { safeApiError, api } from '../../scripts/doxx.mjs';
test('API diagnostics preserve the reason but redact credentials and omit context', () => {
  const token = 'sensitive+token/value=';
  const output = safeApiError({ error_code: 'invalid_type', message: `Unsupported tunnel type. token=${token}; ${encodeURIComponent(token)}; private_key=shortkey`, context: 'never show this', config: { private_key: 'shortkey' } }, [token]);
  assert.match(output, /invalid_type.*Unsupported tunnel type/);
  assert.doesNotMatch(output, /sensitive|shortkey|never show this/);
  assert.match(output, /\[redacted\]/);
});
test('API errors report sanitized server validation messages', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 400, json: async () => ({ status: 'error', message: 'Invalid tunnel type' }) }));
  await assert.rejects(api('create_tunnel', {}, false), /HTTP 400.*Invalid tunnel type/);
});
