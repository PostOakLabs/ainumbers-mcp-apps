// _authzen.mjs — AuthZEN Authorization API 1.0 request/response SHAPE veneer
// (OpenID Standards Track, Mar 2026) over the OCG §21.4 decision-gate evaluator.
//
// Pure mapping module. Does NOT replace or alter comparator gates (provability
// moat) — it only translates an AuthZEN evaluation request into a call to the
// SAME `evaluateGate` (kernels/_gateval.mjs) every executing surface uses, then
// shapes the result back into an AuthZEN {decision, context} response. No new
// gate semantics, no new op, no new routing rule.
//
// Decision mapping (documented, not implied): `next === "escalate"` (§22.8.1)
// -> decision:false (automated path denied, human review required); every other
// `next` (a step id or "end") -> decision:true (automated path proceeds).
//
// PURE ECMA-262, same constraints as _gateval.mjs: no Date, no Math.random, no
// I/O, no network. Deterministic and total for any well-formed request.

import { evaluateGate, isEscalationTarget } from './kernels/_gateval.mjs';
import { executionHash } from './kernels/_hash.mjs';

function malformed(detail) {
  return { decision: false, context: { error: 'malformed_request', detail } };
}

/**
 * Evaluate an AuthZEN 1.0 request against an OCG §21.4 gate.
 * @param {{
 *   subject:  {type?:string, id:string, properties?:object},
 *   action:   {name:string, properties?:object},
 *   resource: {type?:string, id:string, properties?:object},
 *   context:  {gate:{input:string, rules:Array, default:string}, output_payload:object}
 * }} request
 * @returns {{decision:boolean, context:object}}
 */
export function authzenEvaluate(request) {
  if (request === null || typeof request !== 'object') {
    return malformed('request must be an object');
  }
  const { subject, action, resource, context } = request;

  if (!subject || typeof subject !== 'object' || typeof subject.id !== 'string' || !subject.id.length) {
    return malformed('subject.id (non-empty string) is required');
  }
  if (!action || typeof action !== 'object' || typeof action.name !== 'string' || !action.name.length) {
    return malformed('action.name (non-empty string) is required');
  }
  if (!resource || typeof resource !== 'object' || typeof resource.id !== 'string' || !resource.id.length) {
    return malformed('resource.id (non-empty string) is required');
  }
  if (!context || typeof context !== 'object') {
    return malformed('context is required');
  }
  const { gate, output_payload: outputPayload } = context;
  if (!gate || typeof gate !== 'object' || typeof gate.input !== 'string' ||
      !Array.isArray(gate.rules) || typeof gate.default !== 'string') {
    return malformed('context.gate must be an OCG §21.4 gate: {input, rules[], default}');
  }
  if (outputPayload === null || typeof outputPayload !== 'object') {
    return malformed('context.output_payload (object) is required — the payload the gate evaluates against');
  }

  const decisionRecord = evaluateGate(gate, outputPayload);
  const decision = !isEscalationTarget(decisionRecord.next);

  return {
    decision,
    context: {
      subject_id: subject.id,
      action_name: action.name,
      resource_id: resource.id,
      gate_decision: decisionRecord,
    },
  };
}

/**
 * Same evaluation as `authzenEvaluate`, plus the "provable" delta: an OCG
 * §6/§20 execution_hash over the exact {gate, output_payload} the decision
 * was made from. This is the differentiator over every other AuthZEN PDP in
 * the authzen-interop.net registry — the decision ships with a receipt an
 * independent party can recompute (or check via `verify_execution_hash`)
 * without trusting this server's word for it. Malformed requests short-circuit
 * before a hash is even attempted (nothing valid was evaluated).
 * @param {Parameters<typeof authzenEvaluate>[0]} request
 * @returns {Promise<ReturnType<typeof authzenEvaluate> & {context: {execution_hash?: string, verify?: object}}>}
 */
export async function authzenEvaluateWithReceipt(request) {
  const result = authzenEvaluate(request);
  if (result.context.error) return result;

  const { gate, output_payload: outputPayload } = request.context;
  const execution_hash = await executionHash(gate, outputPayload);

  return {
    ...result,
    context: {
      ...result.context,
      execution_hash,
      verify: {
        method: 'OCG §6/§20 execution_hash: SHA-256 over the canonical {policy_parameters, output_payload} preimage',
        policy_parameters: gate,
        output_payload: outputPayload,
        tool: 'verify_execution_hash (https://mcp.ainumbers.co/mcp)',
      },
    },
  };
}
