// freeze-class: exempt(Tim directive 2026-08-25 — wave 0-2 guardrail build); ships DEFAULT-OFF
//
// lane-counter.do.mjs — Durable Object wrapper (LANE_COUNTER) around the pure core.
// Storage contract: state under key 'board', audit tail under 'audit' (last 2000 lines).
// Fail-closed: ceilings come from KV 'lane-ceilings.json'; a KV miss or a missing
// measured_at refuses service (HTTP 503) rather than guessing a limit (SPEC-DR-05 §2.6).
import {
  loadCeilings, initialBoard, acquire, release, reconcileFromAudit, statusView,
} from './lane-counter-core.mjs';

const AUDIT_TAIL = 2000;

export class LANE_COUNTER {
  constructor(state, env) {
    this.state = state;
    this.env = env || {};
    this.ceilings = null;
    this.boardState = null;
  }

  async loadCeilingsOnce() {
    if (this.ceilings) return this.ceilings;
    let raw = null;
    try {
      if (this.env.LANE_CEILINGS && typeof this.env.LANE_CEILINGS.get === 'function') {
        raw = await this.env.LANE_CEILINGS.get('lane-ceilings.json');
      }
    } catch { /* KV error ⇒ treated as miss below */ }
    if (!raw) {
      const er = new Error('lane-ceilings.json unavailable (KV miss) — refusing to serve without measured limits');
      er.code = 'CEILINGS-MISSING';
      throw er;
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) {
      throw new Error(`lane-ceilings FAIL-CLOSED: malformed JSON (${e.message})`);
    }
    this.ceilings = loadCeilings(parsed);
    return this.ceilings;
  }

  async ensureBoard() {
    const ceilings = await this.loadCeilingsOnce();
    const storedState = await this.state.storage.get('board');
    const storedAudit = (await this.state.storage.get('audit')) || [];
    if (storedState && Array.isArray(storedState.audit ?? null) === false) {
      // shape guard — corrupted payload rebuilds from the audit log
      this.boardState = null;
    }
    if (!this.boardState) {
      if (storedAudit.length > 0) {
        // AC5 reconciliation: the isolate died; replay the persisted audit over a fresh board.
        this.boardState = reconcileFromAudit(initialBoard(ceilings, Date.now()), storedAudit, Date.now());
      } else {
        this.boardState = initialBoard(ceilings, Date.now());
      }
    }
    this.boardState.audit = storedAudit;
    return this.boardState;
  }

  async persist(board) {
    await this.state.storage.put('board', board);
    await this.state.storage.put('audit', board.audit.slice(-AUDIT_TAIL));
  }

  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/status') {
        const b = await this.ensureBoard();
        return json(statusView(b, Math.floor(Date.now() / 1000)));
      }
      if (request.method === 'POST' && url.pathname === '/acquire') {
        const b = await this.ensureBoard();
        const bodyIn = await request.json().catch(() => ({}));
        const out = acquire(b, bodyIn || {}, Math.floor(Date.now() / 1000));
        await this.persist(b);
        return json(out);
      }
      if (request.method === 'POST' && url.pathname === '/release') {
        const b = await this.ensureBoard();
        const bodyIn = await request.json().catch(() => ({}));
        const out = release(b, bodyIn || {}, Math.floor(Date.now() / 1000));
        await this.persist(b);
        return json(out);
      }
      return json({ error: 'not-found' }, 404);
    } catch (e) {
      if (e.code === 'CEILINGS-MISSING' || /FAIL-CLOSED/.test(e.message)) {
        return json({ error: 'fail-closed', detail: e.message }, 503);
      }
      return json({ error: 'internal', detail: String(e.message) }, 500);
    }
  }
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
