// check-wasm-deterministic.mjs — CI gate (CHEAPWINS-SPEC.md §CW-1.b).
// Statically inspects the shipped quickjs-ng guest wasm binary(ies) and FAILS the build if the
// module falls outside the WebAssembly 3.0 Deterministic Profile.
//
// THREE ASSERTIONS, ALL MUST PASS:
//   1. No relaxed-SIMD opcodes (0xFD prefix, subopcode 0x100-0x12F).
//   2. No shared-memory flag (memory section + memory imports: limits flag bit 0x02).
//   3. No threads/atomics ops (0xFE prefix — any opcode there is a violation).
//
// Every function body in the code section is walked as a real opcode stream (LEB128-decoded,
// immediates skipped by shape) — never byte-grepped, which yields false hits inside immediates.
// SAFETY NET: each code entry declares its own byte length. If the walk doesn't land exactly on
// that boundary, the parser desynced (an opcode shape it doesn't know) — that FAILS the gate
// loudly instead of silently passing on an unrecognized instruction. Extend the opcode tables
// below if a legitimate desync is diagnosed; never bypass the check.
//
// Second copy (site repo, ../repo/tools/kernel-vm-widget.html, single-lineage): checked
// byte-identical when the sibling checkout is present. Worker CI does not check out the site
// repo for this step, so absence is a log line, never a failure — this sub-check only fires
// when run locally from the shared workspace root.

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------- wasm binary extraction ----------

function extractWasmFromHtml(htmlPath) {
  const html = readFileSync(htmlPath, 'utf8');
  const m = html.match(/QUICKJS_NG_WASM_B64\s*=\s*"([A-Za-z0-9+/=]+)"/);
  if (!m) throw new Error(`no QUICKJS_NG_WASM_B64 literal found in ${htmlPath}`);
  return Buffer.from(m[1], 'base64');
}

// ---------- LEB128 / byte-stream reader ----------

class Reader {
  constructor(buf, pos = 0) {
    this.buf = buf;
    this.pos = pos;
  }
  eof() { return this.pos >= this.buf.length; }
  u8() { return this.buf[this.pos++]; }
  bytes(n) { const s = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return s; }
  uleb32() {
    let result = 0, shift = 0, byte;
    do {
      byte = this.buf[this.pos++];
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return result >>> 0;
  }
  // Signed LEB128, arbitrary width (used for blocktype s33 and const immediates we skip by byte-count).
  sleb(maxBits = 64) {
    let result = 0n, shift = 0n, byte;
    do {
      byte = this.buf[this.pos++];
      result |= BigInt(byte & 0x7f) << shift;
      shift += 7n;
    } while (byte & 0x80);
    if (shift < BigInt(maxBits) && (byte & 0x40)) result |= -1n << shift;
    return result;
  }
}

// ---------- module section walk ----------

const SEC = {
  TYPE: 1, IMPORT: 2, FUNCTION: 3, TABLE: 4, MEMORY: 5, GLOBAL: 6,
  EXPORT: 7, START: 8, ELEMENT: 9, CODE: 10, DATA: 11, DATACOUNT: 12,
};

function parseModule(buf) {
  if (buf.length < 8 || buf.readUInt32LE(0) !== 0x6d736100) {
    throw new Error('not a wasm module (bad magic)');
  }
  const r = new Reader(buf, 8);
  const sections = {};
  while (!r.eof()) {
    const id = r.u8();
    const size = r.uleb32();
    const start = r.pos;
    sections[id] = sections[id] || [];
    sections[id].push({ start, end: start + size });
    r.pos = start + size;
  }
  return sections;
}

// limits: flags:u8, min:uleb32, [max:uleb32 if flags&1]. shared bit is flags&0x02.
function readLimits(r) {
  const flags = r.u8();
  r.uleb32(); // min
  if (flags & 0x01) r.uleb32(); // max
  return { shared: !!(flags & 0x02) };
}

function checkMemorySection(buf, sections, violations) {
  for (const { start, end } of sections[SEC.MEMORY] || []) {
    const r = new Reader(buf, start);
    const count = r.uleb32();
    for (let i = 0; i < count; i++) {
      const { shared } = readLimits(r);
      if (shared) violations.push(`memory section: memory #${i} declares the shared-memory flag`);
    }
    if (r.pos !== end) throw new Error(`memory section parse desync (pos ${r.pos} != end ${end})`);
  }
}

function checkImportSection(buf, sections, violations) {
  for (const { start, end } of sections[SEC.IMPORT] || []) {
    const r = new Reader(buf, start);
    const count = r.uleb32();
    for (let i = 0; i < count; i++) {
      readName(r); // module
      readName(r); // name
      const kind = r.u8();
      if (kind === 0x00) { r.uleb32(); } // func: typeidx
      else if (kind === 0x01) { r.u8(); readLimits(r); } // table: reftype + limits
      else if (kind === 0x02) { // memory: limits
        const { shared } = readLimits(r);
        if (shared) violations.push(`import section: memory import #${i} declares the shared-memory flag`);
      } else if (kind === 0x03) { r.u8(); r.u8(); } // global: valtype + mutability
      else throw new Error(`import section: unknown import kind 0x${kind.toString(16)} (parser desync)`);
    }
    if (r.pos !== end) throw new Error(`import section parse desync (pos ${r.pos} != end ${end})`);
  }
}

function readName(r) {
  const len = r.uleb32();
  return r.bytes(len);
}

// ---------- opcode-stream walk (code section) ----------

const RELAXED_SIMD_MIN = 0x100;
const RELAXED_SIMD_MAX = 0x12f;

// 0xFC (misc numeric / bulk-memory / table) subopcode -> extra immediates beyond the subop itself.
// 'none' | 'idx' (one uleb32) | 'idx2' (two uleb32)
const MISC_SUBOP_SHAPE = {
  0: 'none', 1: 'none', 2: 'none', 3: 'none', 4: 'none', 5: 'none', 6: 'none', 7: 'none', // trunc_sat
  8: 'idx2',  // memory.init: dataidx, memidx
  9: 'idx',   // data.drop: dataidx
  10: 'idx2', // memory.copy: dstmem, srcmem
  11: 'idx',  // memory.fill: memidx
  12: 'idx2', // table.init: elemidx, tableidx
  13: 'idx',  // elem.drop: elemidx
  14: 'idx2', // table.copy: dsttable, srctable
  15: 'idx',  // table.grow: tableidx
  16: 'idx',  // table.size: tableidx
  17: 'idx',  // table.fill: tableidx
};

// 0xFD (SIMD) subopcode -> immediate shape for the STANDARD (non-relaxed) set actually used.
// 'none' | 'memarg' | 'memarg+lane' | 'v128' (16 raw bytes) | 'lane' (1 byte)
function simdImmediateShape(subop) {
  if (subop <= 10) return 'memarg';                 // v128.load* / loadNxM_s/u / splat loads
  if (subop === 11) return 'memarg';                 // v128.store
  if (subop === 12) return 'v128';                   // v128.const
  if (subop === 13) return 'v128';                   // i8x16.shuffle (16 lane-index bytes)
  if (subop >= 14 && subop <= 20) return 'none';      // swizzle, splats
  if (subop >= 21 && subop <= 34) return 'lane';      // extract_lane / replace_lane family
  if (subop >= 84 && subop <= 91) return 'memarg+lane'; // v128.load*_lane / store*_lane
  if (subop === 92 || subop === 93) return 'memarg';  // v128.load32_zero / load64_zero
  return 'none'; // remaining SIMD ops (arith/compare/bitwise/convert) carry no immediate
}

function skipBlockType(r) {
  r.sleb(33); // block/loop/if type: always one signed LEB128(33) regardless of interpretation
}

// Walks one function body's instruction stream from r.pos to the matching top-level 0x0B.
// Returns nothing; throws on any unrecognized shape (desync). Records violations found.
function walkExpr(r, funcIdx, violations) {
  let depth = 1; // one implicit block = the function body itself
  while (depth > 0) {
    if (r.eof()) throw new Error(`func #${funcIdx}: ran off the end of the module mid-body`);
    const op = r.u8();

    if (op === 0x02 || op === 0x03 || op === 0x04) { skipBlockType(r); depth++; continue; } // block/loop/if
    if (op === 0x05) continue; // else
    if (op === 0x0b) { depth--; continue; } // end

    if (op === 0x0c || op === 0x0d) { r.uleb32(); continue; } // br, br_if
    if (op === 0x0e) { // br_table
      const n = r.uleb32();
      for (let i = 0; i < n; i++) r.uleb32();
      r.uleb32(); // default label
      continue;
    }
    if (op === 0x0f || op === 0x00 || op === 0x01) continue; // return, unreachable, nop
    if (op === 0x10) { r.uleb32(); continue; } // call
    if (op === 0x11) { r.uleb32(); r.uleb32(); continue; } // call_indirect: typeidx, tableidx
    if (op === 0x12) { r.uleb32(); continue; } // return_call
    if (op === 0x13) { r.uleb32(); r.uleb32(); continue; } // return_call_indirect

    if (op === 0xd0) { r.u8(); continue; } // ref.null: reftype byte
    if (op === 0xd1) continue; // ref.is_null
    if (op === 0xd2) { r.uleb32(); continue; } // ref.func

    if (op === 0x1a || op === 0x1b) continue; // drop, select
    if (op === 0x1c) { const n = r.uleb32(); r.bytes(n); continue; } // select t*

    if (op >= 0x20 && op <= 0x24) { r.uleb32(); continue; } // local/global get/set/tee
    if (op === 0x25 || op === 0x26) { r.uleb32(); continue; } // table.get/set

    if (op >= 0x28 && op <= 0x3e) { r.uleb32(); r.uleb32(); continue; } // loads/stores: align, offset
    if (op === 0x3f || op === 0x40) { r.u8(); continue; } // memory.size / memory.grow: reserved byte

    if (op === 0x41) { r.sleb(32); continue; } // i32.const
    if (op === 0x42) { r.sleb(64); continue; } // i64.const
    if (op === 0x43) { r.bytes(4); continue; }  // f32.const
    if (op === 0x44) { r.bytes(8); continue; }  // f64.const

    if (op >= 0x45 && op <= 0xc4) continue; // comparisons/arith/conversions/sign-ext: no immediate

    if (op === 0xfc) { // misc: trunc_sat / bulk-memory / table
      const subop = r.uleb32();
      const shape = MISC_SUBOP_SHAPE[subop];
      if (shape === undefined) throw new Error(`func #${funcIdx}: unknown 0xFC subopcode ${subop} (parser desync — extend MISC_SUBOP_SHAPE)`);
      if (shape === 'idx') r.uleb32();
      else if (shape === 'idx2') { r.uleb32(); r.uleb32(); }
      continue;
    }

    if (op === 0xfd) { // SIMD
      const subop = r.uleb32();
      if (subop >= RELAXED_SIMD_MIN && subop <= RELAXED_SIMD_MAX) {
        violations.push(`func #${funcIdx} @0x${(r.pos - 1).toString(16)}: relaxed-SIMD opcode 0xFD subop 0x${subop.toString(16)}`);
      }
      const shape = simdImmediateShape(subop);
      if (shape === 'memarg') { r.uleb32(); r.uleb32(); }
      else if (shape === 'memarg+lane') { r.uleb32(); r.uleb32(); r.u8(); }
      else if (shape === 'v128') { r.bytes(16); }
      else if (shape === 'lane') { r.u8(); }
      continue;
    }

    if (op === 0xfe) { // threads/atomics — presence alone is a violation; still skip its bytes to keep scanning
      const subop = r.uleb32();
      violations.push(`func #${funcIdx} @0x${(r.pos - 1).toString(16)}: threads/atomics opcode 0xFE subop 0x${subop.toString(16)}`);
      // atomic ops are memarg-shaped except atomic.fence (no immediate); best-effort skip, guarded by the desync check below.
      if (subop !== 0x03) { r.uleb32(); r.uleb32(); }
      continue;
    }

    throw new Error(`func #${funcIdx}: unrecognized opcode 0x${op.toString(16)} at byte ${r.pos - 1} (parser desync — extend the opcode table)`);
  }
}

function checkCodeSection(buf, sections, violations) {
  let funcCount = 0;
  for (const { start, end } of sections[SEC.CODE] || []) {
    const r = new Reader(buf, start);
    const count = r.uleb32();
    for (let i = 0; i < count; i++) {
      const bodySize = r.uleb32();
      const bodyStart = r.pos;
      const bodyEnd = bodyStart + bodySize;
      const localCount = r.uleb32();
      for (let j = 0; j < localCount; j++) { r.uleb32(); r.u8(); } // count, valtype
      walkExpr(r, funcCount, violations);
      if (r.pos !== bodyEnd) {
        throw new Error(`func #${funcCount}: body parse desync — landed at ${r.pos}, expected ${bodyEnd} (extend the opcode table, do not bypass)`);
      }
      r.pos = bodyEnd;
      funcCount++;
    }
    if (r.pos !== end) throw new Error(`code section parse desync (pos ${r.pos} != end ${end})`);
  }
  return funcCount;
}

// ---------- main ----------

// Exported for check-wasm-deterministic.selftest.mjs — returns the violations array for a raw
// wasm buffer without the CLI's logging/exit-code side effects.
export function checkModuleBytes(buf) {
  const violations = [];
  const sections = parseModule(buf);
  checkMemorySection(buf, sections, violations);
  checkImportSection(buf, sections, violations);
  checkCodeSection(buf, sections, violations);
  return violations;
}

function checkModule(label, buf) {
  const violations = checkModuleBytes(buf);
  console.log(`  ${label}: ${buf.length} bytes`);
  return violations;
}

// Only run the CLI (extract real wasm, exit process) when invoked directly — not on import
// (the self-test imports checkModuleBytes without wanting the process to exit).
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {

const WORKER_WASM_HTML = resolve(ROOT, 'data', 'tools', 'kernel-vm-widget.html');
if (!existsSync(WORKER_WASM_HTML)) {
  console.error(`✗ vendored wasm carrier not found: ${WORKER_WASM_HTML} (run node generate.mjs first)`);
  process.exit(1);
}

console.log('check-wasm-deterministic: WebAssembly 3.0 Deterministic Profile gate (CHEAPWINS-SPEC.md §CW-1.b)');

let allViolations = [];
let workerBuf;
try {
  workerBuf = extractWasmFromHtml(WORKER_WASM_HTML);
  allViolations = allViolations.concat(checkModule('worker: data/tools/kernel-vm-widget.html', workerBuf));
} catch (e) {
  console.error(`✗ failed to parse worker-vendored wasm: ${e.message}`);
  process.exit(1);
}

// Single-lineage cross-check: only when the sibling site checkout is present locally.
const SITE_WASM_HTML = resolve(ROOT, '..', 'repo', 'tools', 'kernel-vm-widget.html');
if (existsSync(SITE_WASM_HTML)) {
  try {
    const siteBuf = extractWasmFromHtml(SITE_WASM_HTML);
    if (Buffer.compare(siteBuf, workerBuf) !== 0) {
      allViolations.push(`single-lineage: site repo's wasm (${SITE_WASM_HTML}) differs byte-for-byte from the worker-vendored copy`);
    } else {
      console.log('  single-lineage cross-check: site + worker wasm are byte-identical ✓');
    }
  } catch (e) {
    console.error(`  ⚠ single-lineage cross-check skipped: ${e.message}`);
  }
} else {
  console.log('  single-lineage cross-check: skipped (no sibling ../repo checkout — expected in worker CI)');
}

if (allViolations.length > 0) {
  console.error(`\n✗ FAIL: shipped wasm is outside the WebAssembly 3.0 Deterministic Profile:`);
  for (const v of allViolations) console.error(`    ${v}`);
  process.exit(1);
}

console.log('✓ shipped quickjs-ng wasm is Deterministic-Profile clean: no relaxed-SIMD, no shared memory, no atomics.');
process.exit(0);

}
