// check-wasm-deterministic.selftest.mjs — proves check-wasm-deterministic.mjs actually detects
// violations, not just that it passes on the real (already-clean) shipped wasm.
// Hand-builds minimal synthetic wasm modules (no toolchain / npm — none is available in this
// zero-dep worker repo, per STANDING ORDERS #10) and imports the checker's internals indirectly
// by shelling its logic inline would duplicate code, so instead this re-implements the three
// module builders and re-uses checkModuleForTest() copied 1:1 from the gate's own functions via
// dynamic import of the exported test hooks.

import { checkModuleBytes } from './check-wasm-deterministic.mjs';

function u32leb(n) {
  const out = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    out.push(byte);
  } while (n !== 0);
  return out;
}

function section(id, bytes) {
  return [id, ...u32leb(bytes.length), ...bytes];
}

// A module with: no memory, one empty function type, one function importing nothing,
// and a code section whose single function body is supplied by the caller (raw instruction bytes,
// caller must append 0x0b as body end).
function buildModule({ memoryShared = false, bodyBytes = [0x0b] } = {}) {
  const magic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

  // type section: 1 type, () -> ()
  const typeSec = section(1, [1, 0x60, 0, 0]);

  // function section: 1 function, type idx 0
  const funcSec = section(3, [1, 0]);

  // memory section: 1 memory, flags (shared bit optional), min 1
  const memFlags = memoryShared ? 0x02 : 0x00;
  const memSec = section(5, [1, memFlags, 1]);

  // code section: 1 body
  const body = [...u32leb(bodyBytes.length + 1), 0 /* local decl count */, ...bodyBytes];
  const codeSec = section(10, [1, ...body]);

  return Buffer.from([...magic, ...typeSec, ...funcSec, ...memSec, ...codeSec]);
}

let failures = 0;
function expect(label, buf, expectViolations) {
  let violations;
  try {
    violations = checkModuleBytes(buf);
  } catch (e) {
    console.error(`✗ ${label}: threw unexpectedly — ${e.message}`);
    failures++;
    return;
  }
  const got = violations.length > 0;
  if (got === expectViolations) {
    console.log(`✓ ${label}: ${expectViolations ? `caught (${violations.length} violation(s))` : 'clean, as expected'}`);
  } else {
    console.error(`✗ ${label}: expected ${expectViolations ? 'violations' : 'clean'}, got ${violations.length} violation(s): ${violations.join('; ')}`);
    failures++;
  }
}

// 1. Clean module — plain i32.add body: local.get equivalents aren't declared but an empty
//    body (just 'end') is already a valid, clean, zero-import zero-export module.
expect('clean minimal module', buildModule({ bodyBytes: [0x0b] }), false);

// 2. Relaxed-SIMD injected: 0xFD prefix, subopcode 0x100 (i32x4.relaxed_trunc_f32x4_s), no immediate needed for detection since violation fires before immediate skip.
const relaxedSimdBody = [0xfd, ...u32leb(0x100), 0x1a /* drop (wrong arity but parser doesn't type-check) */, 0x0b];
expect('relaxed-SIMD injected', buildModule({ bodyBytes: relaxedSimdBody }), true);

// 3. Shared memory flag set.
expect('shared memory flag', buildModule({ memoryShared: true, bodyBytes: [0x0b] }), true);

// 4. Atomic op injected: 0xFE prefix, subopcode 0x03 = atomic.fence (no immediate).
const atomicBody = [0xfe, ...u32leb(0x03), 0x0b];
expect('atomic op injected', buildModule({ bodyBytes: atomicBody }), true);

if (failures > 0) {
  console.error(`\n✗ self-test FAILED: ${failures} case(s) did not match expectation`);
  process.exit(1);
}
console.log('\n✓ self-test PASSED: checker distinguishes clean vs. corrupted wasm on all 4 cases.');
process.exit(0);
