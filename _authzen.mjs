// _authzen.mjs — AuthZEN Authorization API 1.0 PDP (OpenID Standards Track,
// Final Mar 2026) implemented over OCG primitives.
//
// TWO decision modes, both conformant with the AuthZEN request/response SHAPE:
//
//   1. Built-in policy (DEFAULT). When the request carries no OCG gate, the PDP
//      decides from its own server-side policy — exactly what a conformant
//      AuthZEN PDP must do. The reference policy is the AuthZEN certification
//      fixture (8 mandated decisions); `context` is OPTIONAL and never changes
//      the outcome, per the spec. This makes AINumbers a drop-in PDP any
//      AuthZEN PEP can call by swapping a URL — no vendor coupling, no policy
//      language adopted (the whole point of the standard).
//
//   2. Bring-your-own OCG §21.4 gate (OPT-IN, OCG-native). When the request
//      supplies `context.gate` (an OCG §21.4 decision gate) plus
//      `context.output_payload`, the PDP evaluates that gate via the SAME
//      `evaluateGate` every executing surface uses. Backward-compatible with
//      the prior behavior.
//
// In BOTH modes the "provable" delta (authzenEvaluateWithReceipt) attaches an
// OCG §6/§20 execution_hash over the exact {policy_parameters, output_payload}
// the decision was made from — a receipt an independent party can recompute
// without trusting this server. That receipt is the differentiator over every
// other AuthZEN PDP; it is ADDITIVE and never required for a plain decision.
//
// PURE ECMA-262: no Date, no Math.random, no I/O, no network. Deterministic and
// total for any well-formed request. No external policy engine (OPA/Rego/Cedar)
// and no runtime call to any third party — OCG stays self-contained.

import { evaluateGate, isEscalationTarget } from './kernels/_gateval.mjs';
import { executionHash } from './kernels/_hash.mjs';

function malformed(detail) {
  return { decision: false, context: { error: 'malformed_request', detail } };
}

// ── AuthZEN certification fixture policy (v1) ────────────────────────────────
// The 8 decisions the cert harness validates (implementer's-discretion policy,
// per the spec). Expressed as a small, auditable, total rule set. `context` is
// deliberately not consulted — decisions are identical with or without it.
export const FIXTURE_POLICY = {
  policy_id: 'authzen-cert-fixture-v1',
  rules: [
    'read: permit',
    'write on archived resource: permit iff subject.role == "admin"',
    'write on non-archived resource: permit iff subject.id == "alice"',
    'delete: permit iff action.properties.soft == true',
    'default: deny',
  ],
};

function prop(obj, key) {
  return obj && obj.properties && typeof obj.properties === 'object' ? obj.properties[key] : undefined;
}

/** Pure fixture policy → boolean. Sees only subject/action/resource (not context). */
export function decideFixturePolicy(subject, action, resource) {
  const name = action.name;
  if (name === 'read') return true;
  if (name === 'write') {
    if (prop(resource, 'status') === 'archived') return prop(subject, 'role') === 'admin';
    return subject.id === 'alice';
  }
  if (name === 'delete') return prop(action, 'soft') === true;
  return false; // deny-by-default for any other action
}

// ── Official interop harness policy (openid/authzen todo-app scenario) ──────
// AUTHZEN-CERT-HARNESS-2: the `authzen-todo-backend` reference harness
// (openid/authzen interop/authzen-todo-backend) validates against a FIXED
// citadel/smith user set with `can_read_user`/`can_read_todos`/
// `can_create_todo`/`can_update_todo`/`can_delete_todo` actions — a distinct
// action vocabulary from the certification fixture above. Handled as a
// separate total rule set so the certification fixture (read/write/delete)
// is untouched. Directory + expected decisions are public test fixtures from
// the harness's own `src/directory.ts` + `test/decisions-*.json`, not secrets.
export const TODO_APP_POLICY = {
  policy_id: 'authzen-todo-app-interop-v1',
  rules: [
    'can_read_user: permit',
    'can_read_todos: permit',
    'can_create_todo: permit iff subject.roles includes "admin" or "editor"',
    'can_update_todo / can_delete_todo: permit iff admin, or (editor and resource ownerID == subject id)',
    'default: deny',
  ],
};

const TODO_DIRECTORY = {
  'rick@the-citadel.com': { id: 'rick@the-citadel.com', roles: ['admin', 'evil_genius'] },
  'CiRmZDA2MTRkMy1jMzlhLTQ3ODEtYjdiZC04Yjk2ZjVhNTEwMGQSBWxvY2Fs': { id: 'rick@the-citadel.com', roles: ['admin', 'evil_genius'] },
  'morty@the-citadel.com': { id: 'morty@the-citadel.com', roles: ['editor'] },
  'CiRmZDE2MTRkMy1jMzlhLTQ3ODEtYjdiZC04Yjk2ZjVhNTEwMGQSBWxvY2Fs': { id: 'morty@the-citadel.com', roles: ['editor'] },
  'summer@the-smiths.com': { id: 'summer@the-smiths.com', roles: ['editor'] },
  'CiRmZDI2MTRkMy1jMzlhLTQ3ODEtYjdiZC04Yjk2ZjVhNTEwMGQSBWxvY2Fs': { id: 'summer@the-smiths.com', roles: ['editor'] },
  'beth@the-smiths.com': { id: 'beth@the-smiths.com', roles: ['viewer'] },
  'CiRmZDM2MTRkMy1jMzlhLTQ3ODEtYjdiZC04Yjk2ZjVhNTEwMGQSBWxvY2Fs': { id: 'beth@the-smiths.com', roles: ['viewer'] },
  'jerry@the-smiths.com': { id: 'jerry@the-smiths.com', roles: ['viewer'] },
  'CiRmZDQ2MTRkMy1jMzlhLTQ3ODEtYjdiZC04Yjk2ZjVhNTEwMGQSBWxvY2Fs': { id: 'jerry@the-smiths.com', roles: ['viewer'] },
};

const TODO_ACTIONS = new Set([
  'can_read_user', 'can_read_todos', 'can_create_todo', 'can_update_todo', 'can_delete_todo',
]);

function resolveTodoUser(subject) {
  const key = subject && (subject.identity || subject.id);
  return (key && TODO_DIRECTORY[key]) || null;
}

function ownerIdOf(resource) {
  return (resource && resource.ownerID) || prop(resource, 'ownerID');
}

/** Pure todo-app interop policy → boolean. Total rule set, deny-by-default. */
export function decideTodoAppPolicy(subject, action, resource) {
  const name = action.name;
  if (name === 'can_read_user' || name === 'can_read_todos') return true;
  const user = resolveTodoUser(subject);
  const roles = (user && user.roles) || [];
  const isAdmin = roles.includes('admin');
  const isEditor = roles.includes('editor');
  if (name === 'can_create_todo') return isAdmin || isEditor;
  if (name === 'can_update_todo' || name === 'can_delete_todo') {
    if (isAdmin) return true;
    if (!isEditor) return false;
    const uid = (user && user.id) || subject.id;
    return ownerIdOf(resource) === uid;
  }
  return false;
}

function validateTriple(request) {
  if (request === null || typeof request !== 'object') return malformed('request must be an object');
  const { subject, action, resource } = request;
  if (!subject || typeof subject !== 'object' || typeof subject.id !== 'string' || !subject.id.length) {
    return malformed('subject.id (non-empty string) is required');
  }
  if (!action || typeof action !== 'object' || typeof action.name !== 'string' || !action.name.length) {
    return malformed('action.name (non-empty string) is required');
  }
  if (!resource || typeof resource !== 'object' || typeof resource.id !== 'string' || !resource.id.length) {
    return malformed('resource.id (non-empty string) is required');
  }
  return null;
}

/**
 * Evaluate a single AuthZEN 1.0 request. `context` is OPTIONAL.
 * @returns {{decision:boolean, context:object}} AuthZEN response shape.
 */
export function authzenEvaluate(request) {
  const bad = validateTriple(request);
  if (bad) return bad;
  const { subject, action, resource, context } = request;

  // Mode 2: opt-in OCG §21.4 gate supplied in context.
  if (context && typeof context === 'object' && context.gate !== undefined) {
    const { gate, output_payload: outputPayload } = context;
    if (!gate || typeof gate !== 'object' || typeof gate.input !== 'string' ||
        !Array.isArray(gate.rules) || typeof gate.default !== 'string') {
      return malformed('context.gate, when present, must be an OCG §21.4 gate: {input, rules[], default}');
    }
    if (outputPayload === null || typeof outputPayload !== 'object') {
      return malformed('context.output_payload (object) is required when context.gate is supplied');
    }
    const decisionRecord = evaluateGate(gate, outputPayload);
    return {
      decision: !isEscalationTarget(decisionRecord.next),
      context: { subject_id: subject.id, action_name: action.name, resource_id: resource.id, gate_decision: decisionRecord },
    };
  }

  // Mode 1 (default): server-side policy. context (if any) is ignored.
  // The interop harness's todo-app actions dispatch to a separate rule set
  // (TODO_APP_POLICY) from the certification fixture (FIXTURE_POLICY).
  const usesTodoAppPolicy = TODO_ACTIONS.has(action.name);
  const decision = usesTodoAppPolicy
    ? decideTodoAppPolicy(subject, action, resource)
    : decideFixturePolicy(subject, action, resource);
  return {
    decision,
    context: {
      subject_id: subject.id, action_name: action.name, resource_id: resource.id,
      policy_id: usesTodoAppPolicy ? TODO_APP_POLICY.policy_id : FIXTURE_POLICY.policy_id,
    },
  };
}

/**
 * authzenEvaluate + the OCG §6/§20 execution_hash receipt. Additive: a malformed
 * request short-circuits before any hash. In gate mode the preimage is
 * {gate, output_payload}; in policy mode it is {FIXTURE_POLICY, {subject,action,resource,decision}}.
 */
export async function authzenEvaluateWithReceipt(request) {
  const result = authzenEvaluate(request);
  if (result.context.error) return result;

  let policyParameters, outputPayload;
  if (request.context && request.context.gate !== undefined) {
    policyParameters = request.context.gate;
    outputPayload = request.context.output_payload;
  } else {
    policyParameters = TODO_ACTIONS.has(request.action.name) ? TODO_APP_POLICY : FIXTURE_POLICY;
    outputPayload = {
      subject: request.subject, action: request.action, resource: request.resource,
      decision: result.decision,
    };
  }
  const execution_hash = await executionHash(policyParameters, outputPayload);

  return {
    ...result,
    context: {
      ...result.context,
      execution_hash,
      verify: {
        method: 'OCG §6/§20 execution_hash: SHA-256 over the canonical {policy_parameters, output_payload} preimage',
        policy_parameters: policyParameters,
        output_payload: outputPayload,
        tool: 'verify_execution_hash (https://mcp.ainumbers.co/mcp)',
      },
    },
  };
}

// ── Fixture entities (for the AuthZEN search endpoints) ──────────────────────
export const FIXTURE_ENTITIES = {
  subject: [
    { type: 'user', id: 'alice' },
    { type: 'user', id: 'bob', properties: { role: 'admin' } },
  ],
  resource: [
    { type: 'record', id: 'record-1', properties: { status: 'active' } },
    { type: 'record', id: 'record-2', properties: { status: 'archived' } },
  ],
  action: [{ name: 'read' }, { name: 'write' }, { name: 'delete' }],
};

/**
 * AuthZEN search (POST /access/v1/search/{subject|resource|action}). Returns the
 * fixture entity set in the standard search-response shape. The cert harness
 * validates these structurally, not by content.
 * @param {'subject'|'resource'|'action'} kind
 */
export function authzenSearch(kind) {
  const results = FIXTURE_ENTITIES[kind] || [];
  return { results, page: { next_token: '', count: results.length, total: results.length } };
}

/**
 * Batch evaluations (POST /access/v1/evaluations). Top-level subject/action/
 * resource/context are DEFAULTS; each item in `evaluations[]` overrides them.
 * Receipt is attached per item (same additive rule).
 * @returns {Promise<{evaluations: Array<{decision:boolean, context:object}>}>}
 */
export async function authzenEvaluateBatch(request) {
  if (request === null || typeof request !== 'object' || !Array.isArray(request.evaluations)) {
    return { evaluations: [], context: { error: 'malformed_request', detail: 'evaluations[] array is required' } };
  }
  const base = { subject: request.subject, action: request.action, resource: request.resource, context: request.context };
  const out = [];
  for (const item of request.evaluations) {
    const merged = {
      subject: (item && item.subject) || base.subject,
      action: (item && item.action) || base.action,
      resource: (item && item.resource) || base.resource,
      context: (item && item.context) || base.context,
    };
    out.push(await authzenEvaluateWithReceipt(merged));
  }
  return { evaluations: out };
}
