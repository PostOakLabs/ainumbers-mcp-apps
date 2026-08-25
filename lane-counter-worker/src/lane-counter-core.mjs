// freeze-class: exempt(Tim directive 2026-08-25 — wave 0-2 guardrail build); ships DEFAULT-OFF
//
// lane-counter-core.mjs — SPEC-DR-05 §2.1–2.3 pure decision logic for the LANE_COUNTER DO.
// Storage-agnostic: operates on plain state objects so unit tests need no Workers runtime.
//
// State shape (persisted by the DO wrapper):
//   board = { lanes: { <lane>: { ceiling, active: {<session>: {ts}}, queue: [{session, ts}], durations: [ms] } },
//             audit: [ {ts, lane, session, decision, reason} ] }
// Audit is the source of truth (§2.3): every acquire/grant/queue/release/promotion/bypass appends
// one line; decisions that were never logged did not happen.

const DAY_MS = 24 * 60 * 60 * 1000;

// §2.6 — ceilings are data, fail-closed on missing measured_at (PT-04: no folklore limits).
export function loadCeilings(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('lane-ceilings FAIL-CLOSED: payload is not an object');
  }
  const out = {};
  for (const [lane, cfg] of Object.entries(json)) {
    if (!cfg || typeof cfg !== 'object') throw new Error(`lane-ceilings FAIL-CLOSED: lane '${lane}' entry malformed`);
    const ceiling = cfg.ceiling;
    if (!Number.isInteger(ceiling) || ceiling < 1) throw new Error(`lane-ceilings FAIL-CLOSED: lane '${lane}' ceiling must be a positive integer`);
    if (typeof cfg.measured_at !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(cfg.measured_at)) {
      throw new Error(`lane-ceilings FAIL-CLOSED: lane '${lane}' has no measured_at — no folklore limits`);
    }
    out[lane] = { ceiling, measured_at: cfg.measured_at, basis: String(cfg.basis || '') };
  }
  if (Object.keys(out).length === 0) throw new Error('lane-ceilings FAIL-CLOSED: zero lanes declared');
  return out;
}

export function initialBoard(ceilings, nowTs) {
  const lanes = {};
  for (const [lane, cfg] of Object.entries(ceilings)) {
    lanes[lane] = { ceiling: cfg.ceiling, active: {}, queue: [], durations: [] };
  }
  return { lanes, audit: [] };
}

export function appendAudit(board, entry) {
  board.audit.push({
    ts: Number.isFinite(entry.ts) ? entry.ts : 0,
    lane: entry.lane ?? null,
    session: entry.session ?? null,
    decision: String(entry.decision),
    reason: String(entry.reason || ''),
  });
}

// Moving-median occupancy duration, seconds. Advisory by construction; hidden (null)
// until >=3 samples exist (DR-05 open question 2 resolved conservatively).
export function estWaitSec(laneState) {
  const d = (laneState.durations || []).filter(Number.isFinite);
  if (d.length < 3) return null;
  const s = [...d].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const medianMs = s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  return Math.max(1, Math.round(medianMs / 1000));
}

/**
 * §2.1/§2.2/§2.4 acquire. Mutates board, appends exactly one audit line, returns the
 * decision object served to the caller: {decision:'granted'|'queued'|'bypass'|'rejected', …}.
 * Queued responses carry {queued: position, estWaitSec, advisory: true} — never a bare refusal.
 */
export function acquire(board, { lane, session, priority, rowId }, ts) {
  const nowTs = Number.isFinite(ts) ? ts : 0;
  const L = board.lanes[lane];
  if (!L) {
    appendAudit(board, { ts: nowTs, lane, session, decision: 'rejected', reason: 'unknown-lane' });
    return { decision: 'rejected', reason: 'unknown-lane' };
  }
  if (!session) {
    appendAudit(board, { ts: nowTs, lane, session: null, decision: 'rejected', reason: 'missing-session' });
    return { decision: 'rejected', reason: 'missing-session' };
  }
  if (L.active[session]) {
    appendAudit(board, { ts: nowTs, lane, session, decision: 'granted', reason: 'already-active (idempotent)' });
    return { decision: 'granted', alreadyActive: true };
  }
  const qIdx = L.queue.findIndex((q) => q.session === session);
  if (qIdx >= 0) {
    appendAudit(board, { ts: nowTs, lane, session, decision: 'queued', reason: 'already-queued (idempotent)' });
    return { decision: 'queued', position: qIdx + 1, estWaitSec: estWaitSec(L), advisory: true };
  }
  if (priority === 'tim') {
    // §2.4 bypass — audit line names the row id; never silent.
    L.active[session] = { ts: nowTs, priority: true, rowId: rowId || null };
    appendAudit(board, { ts: nowTs, lane, session, decision: 'bypass', reason: `priority:tim row=${rowId || '(unnamed)'}` });
    return { decision: 'bypass' };
  }
  if (Object.keys(L.active).length < L.ceiling) {
    L.active[session] = { ts: nowTs };
    appendAudit(board, { ts: nowTs, lane, session, decision: 'granted', reason: 'under-ceiling' });
    return { decision: 'granted' };
  }
  L.queue.push({ session, ts: nowTs });
  const position = L.queue.length; // FIFO, 1-based
  appendAudit(board, { ts: nowTs, lane, session, decision: 'queued', reason: `over-ceiling (${Object.keys(L.active).length}/${L.ceiling})` });
  return { decision: 'queued', position, estWaitSec: estWaitSec(L), advisory: true };
}

/**
 * Release: frees the slot, samples occupancy duration (feeds the moving median), then
 * promotes the FIFO head. The promotion audit line references the released session id (AC2).
 */
export function release(board, { lane, session }, ts) {
  const nowTs = Number.isFinite(ts) ? ts : 0;
  const L = board.lanes[lane];
  if (!L) return { decision: 'noop', reason: 'unknown-lane' };

  if (L.active[session]) {
    const held = L.active[session];
    const durMs = Math.max(0, nowTs * 1000 - held.ts * 1000);
    L.durations.push(durMs);
    while (L.durations.length > 32) L.durations.shift();
    delete L.active[session];
    appendAudit(board, { ts: nowTs, lane, session, decision: 'released', reason: `released ${session} after ${(durMs / 1000).toFixed(1)}s` });

    let promoted = null;
    if (L.queue.length > 0) {
      const next = L.queue.shift();
      L.active[next.session] = { ts: nowTs };
      promoted = next.session;
      appendAudit(board, { ts: nowTs, lane, session: next.session, decision: 'granted', reason: `fifo-promotion after release of ${session}` });
    }
    return { decision: 'released', promoted };
  }

  const qIdx = L.queue.findIndex((q) => q.session === session);
  if (qIdx >= 0) {
    L.queue.splice(qIdx, 1);
    appendAudit(board, { ts: nowTs, lane, session, decision: 'queue-cancelled', reason: 'released from queue' });
    return { decision: 'queue-cancelled' };
  }
  appendAudit(board, { ts: nowTs, lane, session, decision: 'release-noop', reason: 'session not held' });
  return { decision: 'release-noop' };
}

/**
 * AC5 reconciliation: replay the audit log over a fresh board. Grants/bypasses re-add,
 * releases/cancellations remove, promotions arrive as their own granted lines — so the
 * rebuilt state converges on what a live run would have produced. A kill mid-hold cannot
 * leak a slot because the audit survives the isolate (DO storage).
 */
export function reconcileFromAudit(freshBoard, auditLines, nowTs) {
  const b = structuredClone(freshBoard);
  b.audit = [];
  for (const line of auditLines) {
    const laneState = b.lanes[line.lane];
    if (!laneState) continue;
    switch (line.decision) {
      case 'granted':
      case 'bypass':
        laneState.active[line.session] = { ts: Number.isFinite(line.ts) ? line.ts : 0, reconciled: true };
        appendAudit(b, line);
        break;
      case 'queued':
        if (!laneState.queue.some((q) => q.session === line.session)) {
          laneState.queue.push({ session: line.session, ts: Number.isFinite(line.ts) ? line.ts : 0 });
        }
        appendAudit(b, line);
        break;
      case 'released': {
        delete laneState.active[line.session];
        const qi = laneState.queue.findIndex((q) => q.session === line.session);
        if (qi >= 0) laneState.queue.splice(qi, 1);
        appendAudit(b, line);
        break;
      }
      default:
        appendAudit(b, line);
    }
  }
  return b;
}

/** §2.1 status() + §2.2 DR-08 exemption surface: queued entries are visible work-in-progress. */
export function statusView(board, generatedAtTs) {
  const lanes = {};
  const queued = [];
  for (const [lane, L] of Object.entries(board.lanes)) {
    lanes[lane] = {
      active: Object.keys(L.active).length,
      ceiling: L.ceiling,
      queueDepth: L.queue.length,
    };
    L.queue.forEach((q, i) => queued.push({ lane, session: q.session, position: i + 1 }));
  }
  return { lanes, queued, generatedAt: Number.isFinite(generatedAtTs) ? generatedAtTs : Date.now(), queuedExemptFromHoleSweep: true };
}
