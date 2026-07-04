// OCGR embedded-bundle vendor + drift gate.
//
// embed/lib/ holds BYTE-IDENTICAL copies of the canonical OCG primitives so the bundle
// is self-contained (a firm can drop embed/lib/ + embed/verify.mjs and verify offline).
// "Copy" — never "fork": this script re-copies them from their single sources and, in
// --check mode, fails if a committed copy has drifted. Wire --check into preflight/CI.
//
//   node embed/vendor.mjs           # refresh embed/lib/ from the canonical sources
//   node embed/vendor.mjs --check   # exit 1 if any embed/lib/ copy != its source
//
// Sources:
//   _hash.mjs, _proof.mjs             <- mcp-apps-poc/kernels/          (this repo, worktree)
//   _computeproof.mjs, _noble-*.mjs   <- ../repo committed HEAD          (site repo, §18 verifier)

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));   // mcp-apps-poc/embed/
const root = here + '../';                                   // mcp-apps-poc/

// name -> function returning the canonical source bytes (Buffer).
const SOURCES = {
  '_hash.mjs':              () => readFileSync(root + 'kernels/_hash.mjs'),
  '_proof.mjs':             () => readFileSync(root + 'kernels/_proof.mjs'),
  '_gateval.mjs':           () => readFileSync(root + 'kernels/_gateval.mjs'),
  '_computeproof.mjs':      () => execFileSync('git', ['-C', root + '../repo', 'show', 'HEAD:chaingraph/kernels/_computeproof.mjs']),
  '_noble-bn254.bundle.mjs':() => execFileSync('git', ['-C', root + '../repo', 'show', 'HEAD:chaingraph/kernels/_noble-bn254.bundle.mjs']),
};

const check = process.argv.includes('--check');
let drift = 0;
for (const [name, getSrc] of Object.entries(SOURCES)) {
  const src = getSrc();
  const dst = here + 'lib/' + name;
  if (check) {
    let cur;
    try { cur = readFileSync(dst); } catch { cur = Buffer.alloc(0); }
    if (!cur.equals(src)) { drift++; console.error(`DRIFT: embed/lib/${name} differs from its canonical source.`); }
    else console.log(`ok  embed/lib/${name}`);
  } else {
    writeFileSync(dst, src);
    console.log(`vendored embed/lib/${name} (${src.length}b)`);
  }
}
if (check && drift) { console.error(`\nvendor drift: ${drift} file(s). Run: node embed/vendor.mjs`); process.exit(1); }
if (check) console.log('\nembed/lib/ is byte-identical to its canonical sources.');
