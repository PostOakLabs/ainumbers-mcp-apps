// freeze-class: exempt(Tim directive 2026-08-25 — wave 0-2 guardrail build); ships DEFAULT-OFF
//
// identity-hmac.test.mjs — RED-first suite for vendor/identity-hmac.mjs (SPEC-DR-06 §2.1–2.3).
// Plain node assert, zero-dep beyond runtime builtins (WebCrypto lives in globalThis.crypto).
import assert from 'node:assert/strict';

const mod = await import('./identity-hmac.mjs');
const { signIdentity, verifyIdentity, constantTimeHexEqual, computeIpHash, refusals } = mod;

const SECRET_ACTIVE = 'wave0-active-secret-bytes';
const SECRET_PENDING = 'wave0-pending-secret-bytes';
const SECRETS_NEWEST_FIRST = [
  { value: SECRET_ACTIVE, label: 'active' },
  { value: SECRET_PENDING, label: 'pending' },
];
const NOW = 1_756_100_000; // fixed unix seconds for determinism

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log(`PASS ${name}`); }
  catch (e) { failures += 1; console.log(`FAIL ${name} — ${e.message}`); }
};
const checkAsync = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures += 1; console.log(`FAIL ${name} — ${e.message}`); }
};

await checkAsync('valid signature verifies against active key', async () => {
  const signed = await signIdentity({ repo: 'mcp-apps-poc', clientIp: '203.0.113.7', timestampSec: NOW, secret: SECRET_ACTIVE });
  assert.equal(signed.ok, true, `sign failed: ${JSON.stringify(signed)}`);
  const headers = {
    'X-AIN-Origin-Repo': 'mcp-apps-poc',
    'X-AIN-Client-IP-Hash': signed.ipHash,
    'X-AIN-Timestamp': String(NOW),
    'X-AIN-Signature': signed.signature,
  };
  const v = await verifyIdentity(headers, { secrets: SECRETS_NEWEST_FIRST, nowSec: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.identity, 'verified');
  assert.equal(v.matchedKeyLabel, 'active');
});

check('constantTimeHexEqual is true for equal, false for unequal, safe on length mismatch', () => {
  assert.equal(constantTimeHexEqual('aabbccdd', 'aabbccdd'), true);
  assert.equal(constantTimeHexEqual('aabbccdd', 'aabbccee'), false);
  assert.equal(constantTimeHexEqual('aabb', 'aabbccdd'), false);
});

await checkAsync('computeIpHash yields 32-hex (16 bytes) and is salt-sensitive', async () => {
  const h1 = await computeIpHash('203.0.113.7', 'salt-a');
  const h2 = await computeIpHash('203.0.113.7', 'salt-b');
  assert.match(h1, /^[0-9a-f]{32}$/);
  assert.notEqual(h1, h2);
});

await checkAsync('fully-absent identity headers take the identity:none path', async () => {
  const v = await verifyIdentity({}, { secrets: SECRETS_NEWEST_FIRST, nowSec: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.identity, 'none');
});

await checkAsync('partial identity headers are refused (fail-closed)', async () => {
  const v = await verifyIdentity({ 'X-AIN-Origin-Repo': 'mcp-apps-poc' }, { secrets: SECRETS_NEWEST_FIRST, nowSec: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'BAD-IDENTITY-HEADERS');
});

await checkAsync('wrong key produces BAD-SIGNATURE (401)', async () => {
  const signed = await signIdentity({ repo: 'mcp-apps-poc', clientIp: '203.0.113.7', timestampSec: NOW, secret: 'not-a-configured-key' });
  const v = await verifyIdentity({
    'X-AIN-Origin-Repo': signed.repo,
    'X-AIN-Client-IP-Hash': signed.ipHash,
    'X-AIN-Timestamp': String(NOW),
    'X-AIN-Signature': signed.signature,
  }, { secrets: SECRETS_NEWEST_FIRST, nowSec: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.status, 401);
  assert.equal(v.code, 'BAD-SIGNATURE');
});

await checkAsync('tampered header byte produces BAD-SIGNATURE', async () => {
  const signed = await signIdentity({ repo: 'mcp-apps-poc', clientIp: '203.0.113.7', timestampSec: NOW, secret: SECRET_ACTIVE });
  const sig = signed.signature;
  const flipped = (sig[0] === 'a' ? 'b' : 'a') + sig.slice(1);
  const v = await verifyIdentity({
    'X-AIN-Origin-Repo': signed.repo,
    'X-AIN-Client-IP-Hash': signed.ipHash,
    'X-AIN-Timestamp': String(NOW),
    'X-AIN-Signature': flipped,
  }, { secrets: SECRETS_NEWEST_FIRST, nowSec: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'BAD-SIGNATURE');
});

await checkAsync('timestamp older than 60s produces CLOCK-SKEW (401)', async () => {
  const signed = await signIdentity({ repo: 'mcp-apps-poc', clientIp: '203.0.113.7', timestampSec: NOW - 61, secret: SECRET_ACTIVE });
  const v = await verifyIdentity({
    'X-AIN-Origin-Repo': signed.repo,
    'X-AIN-Client-IP-Hash': signed.ipHash,
    'X-AIN-Timestamp': String(NOW - 61),
    'X-AIN-Signature': signed.signature,
  }, { secrets: SECRETS_NEWEST_FIRST, nowSec: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.status, 401);
  assert.equal(v.code, 'CLOCK-SKEW');
});

await checkAsync('dual-key acceptance: BOTH configured keys verify, iterating all candidates', async () => {
  for (const secret of [SECRET_PENDING, SECRET_ACTIVE]) {
    const signed = await signIdentity({ repo: 'anchor-suite', clientIp: '198.51.100.9', timestampSec: NOW, secret });
    const v = await verifyIdentity({
      'X-AIN-Origin-Repo': signed.repo,
      'X-AIN-Client-IP-Hash': signed.ipHash,
      'X-AIN-Timestamp': String(NOW),
      'X-AIN-Signature': signed.signature,
    }, { secrets: SECRETS_NEWEST_FIRST, nowSec: NOW });
    assert.equal(v.ok, true, `key '${secret.slice(0, 12)}…' failed`);
  }
});

await checkAsync('salt-absent signer refuses fail-closed and logs the refusal locally', async () => {
  const before = refusals.length;
  const out = await signIdentity({ repo: 'mcp-apps-poc', clientIp: '203.0.113.7', timestampSec: NOW, secret: '' });
  assert.equal(out.ok, false);
  assert.equal(out.code, 'SALT-ABSENT');
  assert.equal(refusals.length, before + 1, 'refusal was not logged locally');
  assert.ok(refusals[refusals.length - 1].loggedAt > 0);
});

if (failures > 0) {
  console.log(`RESULT: FAIL (${failures} failing)`);
  process.exitCode = 1;
} else {
  console.log('RESULT: PASS (all cases green)');
}
