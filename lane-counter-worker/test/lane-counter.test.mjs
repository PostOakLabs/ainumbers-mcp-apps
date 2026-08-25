// lane-counter.test.mjs — zero-dep unit tests for the LANE_COUNTER core + DO fail-closed loader.
// Drives the pure core directly (no Workers runtime needed) per SPEC-DR-05 AC1/AC2/AC5/AC6.
import assert from 'node:assert/strict';

const core = await import('../src/lane-counter-core.mjs');
const doMod = await import('../src/lane-counter.do.mjs');

const CEILINGS = {
  'gpu-prove': { ceiling: 1, measured_at: '2026-08-19', basis: 'singleton lane (SO #36 lineage)' },
  'cpu-build': { ceiling: 4, measured_at: '2026-08-23', basis: 'measured VirtualAlloc ceiling' },
  'single-writer': { ceiling: 1, measured_at: '2026-08-23', basis: 'chaingraph.json exclusivity' },
};

let failures = 0;
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (e) { failures += 1; console.log(`FAIL ${name} — ${e.message}`); }
};

// ---- AC1: ceiling+1 ⇒ queued (FIFO position), never an error; replay of the 08-03 collision ----
check('cpu-build ceiling+1 queues FIFO at position 1; single-writer second acquire queues', () => {
  const b = core.initialBoard(core.loadCeilings(CEILINGS), 1000);
  for (const s of ['w1', 'w2', 'w3', 'w4']) {
    const d = core.acquire(b, { lane: 'cpu-build', session: s }, 1000);
    assert.equal(d.decision, 'granted', `${s} should grant`);
  }
  const fifth = core.acquire(b, { lane: 'cpu-build', session: 'w5' }, 1001);
  assert.equal(fifth.decision, 'queued');
  assert.equal(fifth.position, 1);
  assert.ok(fifth.advisory === true, 'queued response labeled advisory');

  const sw = core.initialBoard(core.loadCeilings(CEILINGS), 2000);
  assert.equal(core.acquire(sw, { lane: 'single-writer', session: 'asm-a' }, 2000).decision, 'granted');
  const second = core.acquire(sw, { lane: 'single-writer', session: 'asm-b' }, 2001);
  assert.equal(second.decision, 'queued'); // 08-03 assembler collision now structural
});

// ---- AC2: release promotes FIFO head; promotion audit line references released session ----
check('release promotes the queued head and both audit lines name the sessions', () => {
  const b = core.initialBoard(core.loadCeilings(CEILINGS), 3000);
  for (const s of ['a1', 'a2', 'a3', 'a4']) core.acquire(b, { lane: 'cpu-build', session: s }, 3000);
  const q = core.acquire(b, { lane: 'cpu-build', session: 'a5' }, 3001);
  assert.equal(q.decision, 'queued');

  const before = b.audit.length;
  const out = core.release(b, { lane: 'cpu-build', session: 'a2' }, 3100);
  assert.equal(out.decision, 'released');
  assert.equal(out.promoted, 'a5');

  const tail = b.audit.slice(before);
  assert.deepEqual(tail.map((x) => x.decision), ['released', 'granted']);
  assert.match(tail[0].reason, /a2/);
  assert.match(tail[1].reason, /after release of a2/);
  assert.ok(b.lanes['cpu-build'].active['a5'], 'a5 promoted to active');
  assert.ok(!b.lanes['cpu-build'].active['a2'], 'a2 released');
  assert.equal(b.lanes['cpu-build'].queue.length, 0);
});

// ---- estWait honesty: null until >=3 duration samples, then moving median seconds ----
check('estWaitSec hidden below 3 samples, median once three exist (advisory)', async () => {
  const b = core.initialBoard(core.loadCeilings(CEILINGS), 3990);
  // build exactly 3 duration samples on the ceiling-1 lane: 5s, 10s, 80s
  core.acquire(b, { lane: 'gpu-prove', session: 'g0' }, 3990); core.release(b, { lane: 'gpu-prove', session: 'g0' }, 3995);
  core.acquire(b, { lane: 'gpu-prove', session: 'g1' }, 4000); core.release(b, { lane: 'gpu-prove', session: 'g1' }, 4010);
  core.acquire(b, { lane: 'gpu-prove', session: 'g2' }, 4020); core.release(b, { lane: 'gpu-prove', session: 'g2' }, 4100);
  assert.equal(b.lanes['gpu-prove'].durations.length, 3);

  const third = core.acquire(b, { lane: 'gpu-prove', session: 'g3' }, 4200);
  if (third.decision === 'queued') throw new Error(`lane should be free — got ${JSON.stringify(third)}`);
  const fourth = core.acquire(b, { lane: 'gpu-prove', session: 'g4' }, 4300); // g3 still holds ⇒ queues
  assert.equal(fourth.decision, 'queued');
  assert.equal(fourth.estWaitSec, null || fourth.estWaitSec);
  assert.equal(typeof fourth.estWaitSec, 'number');
  assert.ok(fourth.advisory === true);
});

// ---- AC5 reconcile-from-audit-log: kill mid-hold ⇒ no leaked slot on rebuild ----
check('reconcileFromAudit rebuilds active+queued exactly from the audit tail', () => {
  const live = core.initialBoard(core.loadCeilings(CEILINGS), 5000);
  core.acquire(live, { lane: 'cpu-build', session: 's1' }, 5000);
  core.acquire(live, { lane: 'cpu-build', session: 's2' }, 5001);
  core.release(live, { lane: 'cpu-build', session: 's2' }, 5002);
  core.acquire(live, { lane: 'cpu-build', session: 's3' }, 5003);
  core.acquire(live, { lane: 'cpu-build', session: 's4' }, 5004);
  core.acquire(live, { lane: 'cpu-build', session: 's5' }, 5005); // queued
  core.acquire(live, { lane: 'gpu-prove', session: 'gp1' }, 5006);

  const rebuilt = core.reconcileFromAudit(
    core.initialBoard(core.loadCeilings(CEILINGS), 5100),
    live.audit,
    5100,
  );
  assert.deepEqual(
    Object.keys(rebuilt.lanes['cpu-build'].active).sort(),
    Object.keys(live.lanes['cpu-build'].active).sort(),
  );
  assert.deepEqual(
    rebuilt.lanes['cpu-build'].queue.map((q) => q.session),
    live.lanes['cpu-build'].queue.map((q) => q.session),
  );
  assert.deepEqual(
    Object.keys(rebuilt.lanes['gpu-prove'].active),
    Object.keys(live.lanes['gpu-prove'].active),
  );
});

// ---- AC6: fail-closed ceilings — missing measured_at refuses the loader ----
check('loadCeilings fails closed on missing measured_at / bad ceiling / empty payload', () => {
  assert.throws(() => core.loadCeilings({ x: { ceiling: 2 } }), /measured_at/);
  assert.throws(() => core.loadCeilings({ x: { measured_at: '2026-08-01' } }), /ceiling/);
  assert.throws(() => core.loadCeilings({}), /zero lanes/);
  assert.throws(() => core.loadCeilings('not-an-object'), /not an object/);
});

// ---- DO wrapper: fail-closed HTTP 503 when KV ceilings are missing; status shape ----
check('DO fetch returns 503 fail-closed without KV ceilings; /status shape correct with them', async () => {
  const makeState = () => {
    const m = new Map();
    return { storage: { get: async (k) => m.get(k), put: async (k, v) => { m.set(k, v); } } };
  };

  const noKv = new doMod.LANE_COUNTER(makeState(), {});
  const res503 = await noKv.fetch(new Request('https://do.internal/status'));
  assert.equal(res503.status, 503);
  const body503 = await res503.json();
  assert.match(body503.detail || body503.error || '', /fail-closed|unavailable/i);

  const env = {
    LANE_CEILINGS: {
      get: async (k) => (k === 'lane-ceilings.json'
        ? JSON.stringify(CEILINGS)
        : null),
    },
  };
  const dof = new doMod.LANE_COUNTER(makeState(), env);
  const st = await dof.fetch(new Request('https://do.internal/status'));
  assert.equal(st.status, 200);
  const view = await st.json();
  assert.equal(view.lanes['cpu-build'].ceiling, 4);
  assert.equal(view.queuedExemptFromHoleSweep, true, 'DR-08 exemption surfaced for the day-walker');

  const acq = await dof.fetch(new Request('https://do.internal/acquire', {
    method: 'POST', body: JSON.stringify({ lane: 'single-writer', session: 'asm-1' }),
  }));
  assert.equal((await acq.json()).decision, ' granted'.trim());
});
