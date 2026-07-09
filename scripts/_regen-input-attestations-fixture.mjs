// _regen-input-attestations-fixture.mjs — one-shot generator for the §23 rfc3161-snapshot fixture
// used by validate-input-attestations.test.mjs. NETWORK SCRIPT (hits the real FreeTSA /tsr endpoint
// once, same precedent as repo/chaingraph/kernels/_regen-anchor-fixtures.mjs) — the gate test itself
// is 100% offline afterward. Re-run only if the fixture needs regenerating.
//
//   node scripts/_regen-input-attestations-fixture.mjs
//
// Mints a REAL TimeStampToken over SHA-256(cgCanon(250000)) — the canonical digest of the
// policy_parameters./amount_usd value below — so the committed fixture proves an actual §20
// rfc3161-tst verification bound to a real §23 input-attestation digest, not a synthetic stand-in.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cgCanon } from '../kernels/_hash.mjs';
import { derRead, derChildrenOf, derOidToString, derSeq, derOid, derNull, derOctet, derBool, derInt } from '../kernels/_anchor-testutil.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'fixtures', 'input-attestations.fixture.json');

const policy_parameters = { loan_id: 'L-2026-0042', amount_usd: 250000, currency: 'USD' };
const pointer = '/amount_usd';
const resolvedValue = policy_parameters.amount_usd;
const expectedDigestHex = createHash('sha256').update(JSON.stringify(cgCanon(resolvedValue))).digest('hex');
console.log('resolved value:', resolvedValue, ' expected_digest_hex:', expectedDigestHex);

const SHA256_OID = '2.16.840.1.101.3.4.2.1';
const hashBytes = Buffer.from(expectedDigestHex, 'hex');
const tsq = derSeq(
  derInt(1),
  derSeq(derSeq(derOid(SHA256_OID), derNull()), derOctet(hashBytes)),
  derBool(true),
);
console.log('requesting TST from FreeTSA…');
const resp = await fetch('https://freetsa.org/tsr', {
  method: 'POST',
  headers: { 'Content-Type': 'application/timestamp-query' },
  body: tsq,
});
if (!resp.ok) throw new Error(`FreeTSA HTTP ${resp.status}`);
const tsr = Buffer.from(await resp.arrayBuffer());

const respSeq = derRead(tsr, 0);
const [statusInfo, tokenNode] = derChildrenOf(tsr, respSeq);
const statusVal = derChildrenOf(tsr, statusInfo)[0];
const status = statusVal.content[0];
if (status !== 0 && status !== 1) throw new Error(`TSA status ${status} (not granted)`);
if (!tokenNode) throw new Error('TSA response has no timeStampToken');
const tstDer = Buffer.from(tokenNode.raw); // ContentInfo — stored VERBATIM (§20/§23)

function parseTst(der) {
  const ci = derRead(der, 0);
  const [oidNode, explicit0] = derChildrenOf(der, ci);
  if (derOidToString(oidNode.content) !== '1.2.840.113549.1.7.2') throw new Error('not CMS SignedData');
  const signedData = derChildrenOf(der, explicit0)[0];
  const kids = derChildrenOf(der, signedData);
  const encapKids = derChildrenOf(der, kids[2]);
  if (derOidToString(encapKids[0].content) !== '1.2.840.113549.1.9.16.1.4') throw new Error('eContentType is not id-ct-TSTInfo');
  const tstInfoOctets = derRead(der, encapKids[1].start);
  const tstInfoDer = tstInfoOctets.content;
  const t = derChildrenOf(tstInfoDer, derRead(tstInfoDer, 0));
  const policyOid = derOidToString(t[1].content);
  const imprint = derChildrenOf(tstInfoDer, t[2]);
  const hashed = imprint[1].content;
  const serial = BigInt('0x' + Buffer.from(t[3].content).toString('hex')).toString(10);
  const genTime = t[4].content.toString('ascii');
  return { policyOid, hashed, serial, genTime };
}
const tst = parseTst(tstDer);
if (!Buffer.from(tst.hashed).equals(hashBytes)) throw new Error('TSA messageImprint != expected_digest_hex');
console.log(`TST granted: policy=${tst.policyOid} serial=${tst.serial} genTime=${tst.genTime}`);

const fixture = {
  policy_parameters,
  input_attestation: {
    type: 'rfc3161-snapshot',
    pointer,
    proof: {
      policy_oid: tst.policyOid,
      serial: tst.serial,
      gen_time: tst.genTime,
      proof: tstDer.toString('base64'),
    },
    source_ref: 'https://freetsa.org/tsr',
  },
  expected_digest_hex: expectedDigestHex,
};
writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n');
console.log('wrote', OUT);
