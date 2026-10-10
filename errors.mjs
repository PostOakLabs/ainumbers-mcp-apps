// errors.mjs — the SINGLE CONSTRUCTION SITE for the worker's JSON-RPC error responses
// (ERROR-REGISTRY-REQUEST-ID-SPEC.md §2 + §3, row AICONTRACT-PART-B-1).
//
// Before this module every protocol-layer error body was hand-rolled inline in worker.mjs (15
// direct JSON.stringify literals + 6 calls through a local helper) and the one structured
// tool-layer error was built ad hoc inside buildServer. Codes, messages, HTTP statuses and `data`
// shapes were de-facto correct — pinned by conformance smoke and CI gates — but existed only as
// inline literals with nothing but review discipline stopping an edit from conflating, say, the
// rate-limit path with a validation error. This registry freezes each condition under a STABLE
// STRING NAME so code and review reference semantics, not magic numbers.
//
// ⛔ THE DOCTRINE (spec §3 "What never changes"):
//   - Wire codes are FROZEN at their measured values: none renamed, none renumbered
//     (-32001 was the old missing-header code, renumbered to -32020 by modelcontextprotocol#2907;
//     -32001 survives ONLY as the watchdog "Server timeout" code — see PROTOCOL_ERRORS notes),
//     none re-typed to strings. Numeric JSON-RPC members stay numeric.
//   - `data` is NOT renamed to `details`; no member moves between error / error.data / top level.
//   - Public message strings are byte-identical to the pre-registry literals; templates
//     interpolate only the variables already interpolated inline. Detail stays in console.error,
//     never on the wire.
//   - Members are only ever ADDED. The two additive deltas of this module are `error.request_id`
//     (spec §3: a fresh correlation uuid per request) and `error.retryable` (BUILD-SPEC
//     MCP-TOOL-ERROR-REGISTRY-1 §2 A1: a property of the CAUSE, never of the call — true only for
//     rate-limit, server-timeout and upstream-unavailable causes). The JSON-RPC `id` member keeps
//     echoing body.id exactly as before — `request_id` is CORRELATION, `id` is REPLY ADDRESSING.
//
// scripts/gate-error-registry.mjs (--check, wired into preflight + ci.yml) makes this registry the
// single construction site: any JSON-RPC error construction outside this file must either call one
// of the constructors below with a registered name or appear in the frozen baseline. Zero deps —
// no package.json change (spec §5.1 ⛔).

// ── Per-request correlation id ────────────────────────────────────────────────────────────────
// Minted ONCE per request by the fetch handler and handed to every constructor that request uses,
// so support can tie a failure response to the server logs for exactly one request.
export const mintRequestId = () => crypto.randomUUID();

// ── §2.1 Protocol layer ───────────────────────────────────────────────────────────────────────
// name → { code, status, message(vars)|string, data?(vars) }.
// `status` is the DEFAULT HTTP status; a call site may override it where the worker's measured
// behaviour is conditional (only protocol.method_not_found.unknown_method does: modern-era 404,
// legacy 200 — scripts/smoke-mcp.mjs §3 asserts both).
//
// Message strings below are byte-identical to the inline literals they replace (spec §2.1
// "verbatim … string" / §6 "Public message strings: byte-identical"). DO NOT reword them.
export const PROTOCOL_ERRORS = {
  // Fast-fail pre-parse guard (audit F1): body was not parseable JSON at all.
  'protocol.parse_error': {
    code: -32700, status: 400,
    message: 'Parse error: request body is not valid JSON',
    retryable: false,
  },

  // WORKER-IDREPLACE-DOS-1 P1-1: JSON-RPC batching removed in MCP revision 2025-06-18.
  'protocol.invalid_request.batching': {
    code: -32600, status: 400,
    message: 'Invalid Request: JSON-RPC batching is not supported (removed in MCP revision 2025-06-18). Send one request per POST.',
    retryable: false,
  },

  // JSON-RPC 2.0 §4: a PRESENT id must be a string, number, or null.
  'protocol.invalid_request.id_type': {
    code: -32600, status: 400,
    message: 'Invalid Request: "id" must be a string, number, or null (JSON-RPC 2.0 §4)',
    retryable: false,
  },

  // Body over MAX_REQUEST_BODY_BYTES. ONE name, THREE call sites (the /access/v1 cap response and
  // the two /mcp pre-parse caps) — each keeps its own measured status via the site.
  'protocol.invalid_request.body_too_large': {
    code: -32600, status: 413,
    message: (vars) => `Invalid Request: body exceeds the ${vars.limit}-byte limit`,
    retryable: false,
  },

  'protocol.method_not_allowed.post_guidance': {
    code: -32601, status: 405,
    message: 'Method Not Allowed: use POST for JSON-RPC, or GET with Accept: text/event-stream and your Mcp-Session-Id (from initialize) for the server-to-client stream.',
    retryable: false,
  },

  'protocol.method_not_allowed.delete_guidance': {
    code: -32601, status: 405,
    message: 'Method Not Allowed: DELETE ends a session and requires the Mcp-Session-Id header issued at initialize. Use POST for JSON-RPC.',
    retryable: false,
  },

  // Single-endpoint rule: the legacy /sse + /messages transport paths are gone (2026-09-11 probe).
  'protocol.method_not_allowed.no_sse_path': {
    code: -32601, status: 405,
    message: 'Method Not Allowed: the MCP endpoint is POST /mcp (Streamable HTTP); there is no separate SSE path. GET /mcp with Accept: text/event-stream opens the server-to-client stream.',
    retryable: false,
  },

  // Unknown RPC method short-circuit (MW2-UNKNOWN-METHOD-GUARD-1). Status is OVERRIDDEN at the
  // call site: modern era → 404, legacy → 200 (smoke-mcp §3/§3b controls assert both; the blanket
  // 200 once regressed the modern leg — worker #306).
  'protocol.method_not_found.unknown_method': {
    code: -32601, status: 200,
    message: (vars) => 'Method not found: ' + vars.method,
    retryable: false,
  },

  // MCP728-CONFORM-FIX-2: an explicit MODERN protocol-version assertion outside the supported set.
  // data shape frozen ({ supported, requested }). -32022, never the SDK's generic -32000.
  'protocol.unsupported_protocol_version': {
    code: -32022, status: 400,
    message: (vars) => `Unsupported protocol version: ${vars.requested}`,
    data: (vars) => ({ supported: vars.supported, requested: vars.requested }),
    retryable: false,
  },

  // Mcp-Protocol-Version header missing/mismatched (SEP-2243 routing). History (spec §1): this
  // condition was originally -32001 and was RENUMBERED to -32020 by modelcontextprotocol#2907 —
  // nobody "restores" the old mapping; -32001 now means ONLY the watchdog timeout below.
  'protocol.header_mismatch': {
    code: -32020, status: 400,
    message: (vars) => `Header mismatch: ${vars.detail}`,
    retryable: false,
  },

  // -32021: wired, but REQUIRED_CLIENT_CAPABILITIES is empty, so unreachable today (worker.mjs
  // measures this). Registered anyway so the day it goes live it is already named.
  'protocol.missing_client_capability': {
    code: -32021, status: 400,
    message: (vars) => 'Missing required client capability: ' + vars.lacking.join(', '),
    data: (vars) => ({ requiredCapabilities: vars.lacking }),
    retryable: false,
  },

  // §2.3 DOCTRINE: throttle is never conflated. -32029 is a TRANSPORT-AVAILABILITY condition —
  // it fires pre-parse, before any validation, and its remedy is time, not input correction. It
  // must never share a code, a message, or a code path with protocol.invalid_params.* (-32602) or
  // protocol.missing_client_capability (-32021), and vice versa. The gate reds any -32029 emitted
  // from anywhere but this entry's single call site (the limiter short-circuit).
  'protocol.rate_limited': {
    code: -32029, status: 429,
    message: 'Rate limit exceeded. Wait and retry.',
    retryable: true,   // A1: the remedy is time — the one protocol cause that says "retry".
  },

  // Per-request modern-era protocol fields (missingRequiredMeta). data.missingFields carries the
  // RAW array; the message carries the join — exactly as the inline original did.
  'protocol.invalid_params.protocol_fields': {
    code: -32602, status: 400,
    message: (vars) => 'Invalid params: request _meta is missing required field(s): ' + vars.missing.join(', '),
    data: (vars) => ({ missingFields: vars.missing }),
    retryable: false,
  },

  // Static fast-path list cursor (buildListPage): token is not one this server issued.
  'protocol.invalid_params.cursor': {
    code: -32602, status: 400,
    message: 'Invalid params: cursor is not a valid page token (echo the nextCursor this server issued)',
    retryable: false,
  },

  // SDK fallback-path list cursor (parseToolsCursorOffset): different grammar, same code, OWN name
  // (spec §2.1: two cursor texts, two names, one code — the two never interpret the same token).
  'protocol.invalid_params.sdk_cursor': {
    code: -32602, status: 400,
    message: 'Invalid params: unknown cursor (this server issues decimal-offset cursors via nextCursor)',
    retryable: false,
  },

  // describe_tool O(1) path: the `{ name: string }` argument precondition.
  'protocol.invalid_params.describe_tool_args': {
    code: -32602, status: 400,
    message: 'Invalid params: describe_tool requires { name: string } — the mcp_name to describe',
    retryable: false,
  },

  // Unknown tool name, answered at the dispatch layer WITHOUT the full ~186-tool build
  // (MCP-728 T2). The `-32602` tool-not-found texts must keep their `Tool not found:` prefix
  // (gate-enforced).
  'protocol.tool_not_found.zero_tools': {
    code: -32602, status: 200,
    message: (vars) => 'Tool not found: ' + vars.toolName,
    retryable: false,
  },

  // describe_tool unknown name + BM25/edit-distance nearest names (data shape frozen).
  'protocol.tool_not_found.nearest': {
    code: -32602, status: 200,
    message: (vars) => 'Tool not found: describe_tool("' + vars.name + '") — no registered mcp_name by that name',
    data: (vars) => ({ nearest_names: vars.nearest, hint: vars.hint }),
    retryable: false,
  },

  // Watchdog "Server timeout" — the ONLY thing -32001 means today (see header_mismatch history).
  'protocol.server_timeout': {
    code: -32001, status: 504,
    message: 'Server timeout',
    retryable: true,   // A1: a timeout is the definition of "the same call may succeed later".
  },

  // Internal error — constant text; the exception detail + stack go to console.error ONLY.
  'protocol.internal_error': {
    code: -32603, status: 500,
    message: 'Internal error',
    retryable: false,  // A1: not a listed availability cause — retrying is not the documented remedy.
  },
};

// ── §2.2 Tool layer ───────────────────────────────────────────────────────────────────────────
// `tool.ijson_violation`: the structured error a hashing tool returns INSTEAD of a digest.
// code -32602 + data.reason 'ijson_violation' are FROZEN — scripts/gate-hash-ijson.mjs asserts
// exactly these two members and any rename reds CI.
//
// The BUILDER for this shape (ijsonErrorResult) stays resident in worker.mjs (inside buildServer,
// where its six call sites live — spec §5.2 "tool `ijsonErrorResult` gains
// `structuredContent.error.request_id`"): it constructs from THIS registry entry and adds the
// additive `structuredContent.error.request_id` member, keeping `content[].text` byte-identical.
// gate-hash-ssot.mjs additionally pins the literal `reason: 'ijson_violation'` inside worker.mjs
// source, which the resident builder preserves.
//
// BUILD-SPEC MCP-TOOL-ERROR-REGISTRY-1 §2 (A1/A2/A3): every entry carries a boolean `retryable` —
// a property of the CAUSE, never of the call: true ONLY for upstream-unavailable causes; false for
// everything deterministic (validation, unknown names, capability mismatch, kernel compute errors).
// The prose tool-error sites migrate onto this registry via toolErrorResult(); `content[].text`
// stays byte-identical (the message templates below are the MOVED inline literals, verbatim).
// `reason` is the stable data.data.reason token (the entry name minus its `tool.` prefix), except
// the frozen `ijson_violation`. Entries with `message: null` are forwarded-prose sites (the text
// comes from a kernel/core exception); the call site passes `text` and it becomes BOTH
// content[].text and structuredContent.error.message, byte-identical. The two `shape`-only entries
// (mandate_error, batch_budget) serve the DOMAIN-JSON sites (§2 A3): their existing structured
// result gains `retryable` + `reason` inside structuredContent and nothing else moves.
export const TOOL_ERRORS = {
  'tool.ijson_violation': {
    code: -32602,
    message: 'Invalid params: input is not I-JSON, so it has no stable canonical form and cannot be hashed.',
    reason: 'ijson_violation',
    retryable: false,   // A1 additive member; every pre-existing member of this entry is frozen.
  },

  // ── input-shape / validation (all deterministic → retryable: false, code -32602) ─────────────
  'tool.invalid_args.chain_steps_exclusive': {
    code: -32602,
    message: 'Provide either chain or steps, not both.',
    reason: 'invalid_args.chain_steps_exclusive',
    retryable: false,
  },
  'tool.invalid_args.chain_steps_required': {
    code: -32602,
    message: 'Provide chain (named) or steps (ad-hoc array of {tool_id, fields?}).',
    reason: 'invalid_args.chain_steps_required',
    retryable: false,
  },
  'tool.invalid_args.artifact_required': {
    code: -32602,
    message: 'Provide a full artifact (with policy_parameters + output_payload + execution_hash) or policy_parameters + output_payload (+ claimed_hash).',
    reason: 'invalid_args.artifact_required',
    retryable: false,
  },
  'tool.invalid_args.attestation_required': {
    code: -32602,
    message: 'Provide a full artifact (with policy_parameters + input_attestations[]) or policy_parameters + input_attestations[].',
    reason: 'invalid_args.attestation_required',
    retryable: false,
  },
  'tool.invalid_args.private_inputs_required': {
    code: -32602,
    message: 'Provide a full artifact (with policy_parameters + private_inputs[]) or policy_parameters + private_inputs[].',
    reason: 'invalid_args.private_inputs_required',
    retryable: false,
  },
  // Forwarded core-builder validation message (buildDisclosureManifestCore throw text).
  'tool.invalid_args.manifest_core': {
    code: -32602,
    message: null,
    reason: 'invalid_args.manifest_core',
    retryable: false,
  },
  'tool.invalid_args.manifest_shape': {
    code: -32602,
    message: 'manifest must include entries[] and merkle_root.',
    reason: 'invalid_args.manifest_shape',
    retryable: false,
  },
  'tool.invalid_args.chain_no_steps': {
    code: -32602,
    message: (vars) => 'Chain "' + vars.chain + '" has no steps.',
    reason: 'invalid_args.chain_no_steps',
    retryable: false,
  },
  'tool.invalid_args.artifact_fields': {
    code: -32602,
    message: (vars) => 'Artifact missing required ChainGraph Standard fields: ' + vars.problems + '.',
    reason: 'invalid_args.artifact_fields',
    retryable: false,
  },
  'tool.invalid_args.mode_required': {
    code: -32602,
    message: 'Provide either pre_computed_artifact or tool_id. To list available ChainGraph tool_ids call build_chaingraph.',
    reason: 'invalid_args.mode_required',
    retryable: false,
  },
  // Kernel/core compute failure (deterministic: same input → same error, A1). Forwarded text.
  'tool.compute_error': {
    code: -32603,
    message: null,
    reason: 'compute_error',
    retryable: false,
  },
  // Forwarded core-builder validation message (buildSessionReceiptCore throw text).
  'tool.invalid_args.receipt_core': {
    code: -32602,
    message: null,
    reason: 'invalid_args.receipt_core',
    retryable: false,
  },
  'tool.invalid_args.claims': {
    code: -32602,
    message: 'claims must be a non-empty object of key-value pairs.',
    reason: 'invalid_args.claims',
    retryable: false,
  },
  'tool.invalid_args.sd_jwt': {
    code: -32602,
    message: 'sd_jwt must be a non-empty string.',
    reason: 'invalid_args.sd_jwt',
    retryable: false,
  },
  'tool.invalid_args.sd_jwt_malformed': {
    code: -32602,
    message: (vars) => 'Malformed sd_jwt: ' + vars.detail,
    reason: 'invalid_args.sd_jwt_malformed',
    retryable: false,
  },
  'tool.invalid_args.evidence_required': {
    code: -32602,
    message: (vars) => `Step "${vars.stepId}" is a blocking gate requiring ${vars.requirement} evidence; none was supplied.`,
    reason: 'invalid_args.evidence_required',
    retryable: false,
  },
  // Forwarded HA evidence-core message (assembleEvidenceBundle throw text).
  'tool.invalid_args.ha_bundle': {
    code: -32602,
    message: null,
    reason: 'invalid_args.ha_bundle',
    retryable: false,
  },
  // Forwarded in-toto core message (recordChainRunAsLinks throw text).
  'tool.invalid_args.intoto_bundle': {
    code: -32602,
    message: null,
    reason: 'invalid_args.intoto_bundle',
    retryable: false,
  },
  'tool.invalid_args.evidence_session_receipt': {
    code: -32602,
    message: (vars) => 'session_receipt: ' + vars.detail,
    reason: 'invalid_args.evidence_session_receipt',
    retryable: false,
  },
  'tool.invalid_args.evidence_ha_bundle': {
    code: -32602,
    message: (vars) => 'ha_bundle: ' + vars.detail,
    reason: 'invalid_args.evidence_ha_bundle',
    retryable: false,
  },
  'tool.invalid_args.evidence_disclosure_manifest': {
    code: -32602,
    message: (vars) => 'disclosure_manifest: ' + vars.detail,
    reason: 'invalid_args.evidence_disclosure_manifest',
    retryable: false,
  },
  // Forwarded OTLP lint/verify message (validateOtlpTrace / bundle-mode throw texts).
  'tool.invalid_args.otlp_trace': {
    code: -32602,
    message: null,
    reason: 'invalid_args.otlp_trace',
    retryable: false,
  },
  'tool.invalid_args.otlp_input': {
    code: -32602,
    message: null,
    reason: 'invalid_args.otlp_input',
    retryable: false,
  },
  'tool.invalid_args.redline_strings': {
    code: -32602,
    message: 'original and revised must both be strings.',
    reason: 'invalid_args.redline_strings',
    retryable: false,
  },
  // Forwarded lei-kyb validation message (LEI structural check, offline, pre-fetch).
  'tool.invalid_args.lei_lookup': {
    code: -32602,
    message: null,
    reason: 'invalid_args.lei_lookup',
    retryable: false,
  },
  // Forwarded ACDC/vLEI structural-check message.
  'tool.invalid_args.acdc_credential': {
    code: -32602,
    message: null,
    reason: 'invalid_args.acdc_credential',
    retryable: false,
  },
  // Forwarded workbook evaluator/parser message (WorkbookError text).
  'tool.invalid_args.workbook': {
    code: -32602,
    message: null,
    reason: 'invalid_args.workbook',
    retryable: false,
  },
  'tool.invalid_args.xml_string': {
    code: -32602,
    message: 'xml must be a string.',
    reason: 'invalid_args.xml_string',
    retryable: false,
  },
  // Forwarded camt.053 parse-throw message (XmlParseError text).
  'tool.invalid_args.camt_xml': {
    code: -32602,
    message: null,
    reason: 'invalid_args.camt_xml',
    retryable: false,
  },
  'tool.invalid_args.recon_strings': {
    code: -32602,
    message: 'statement_xml and expectations_csv must both be strings.',
    reason: 'invalid_args.recon_strings',
    retryable: false,
  },
  // Forwarded recon validation message (statement/CSV schema-subset failure text).
  'tool.invalid_args.recon_inputs': {
    code: -32602,
    message: null,
    reason: 'invalid_args.recon_inputs',
    retryable: false,
  },
  'tool.invalid_args.delegation_shape': {
    code: -32602,
    message: (vars) => 'Invalid arguments for ' + vars.toolName + ': this tool takes its inputs NESTED under "policy_parameters", ' +
      'and none of the key(s) you sent (' + vars.rawKeys.join(', ') + ') is a recognised top-level argument — ' +
      'they were discarded by schema validation, so nothing could be computed. ' +
      'Retry as {"policy_parameters": {' + vars.rawKeys.map((k) => JSON.stringify(k) + ': …').join(', ') + '}}. ' +
      'The only top-level arguments are: ' + vars.argKeys.join(', ') + '. ' +
      "Field names for policy_parameters are in this tool's manifest.",
    reason: 'invalid_args.delegation_shape',
    retryable: false,
  },
  'tool.invalid_args.call_tool_name': {
    code: -32602,
    message: 'call_tool needs { name: "<exact mcp_name>", arguments: { ... } } — "name" was missing or not a string; call find_tool(query) to get a name.',
    reason: 'invalid_args.call_tool_name',
    retryable: false,
  },
  'tool.invalid_args.call_tool_self': {
    code: -32602,
    message: 'call_tool cannot target itself; pass the name of the tool you want to run.',
    reason: 'invalid_args.call_tool_self',
    retryable: false,
  },
  'tool.invalid_args.call_tool_arguments': {
    code: -32602,
    message: 'call_tool "arguments" must be the target tool\'s arguments OBJECT (or omitted for a no-argument tool).',
    reason: 'invalid_args.call_tool_arguments',
    retryable: false,
  },

  // ── unknown-name family (deterministic → retryable: false, -32602 not-found family) ─────────
  'tool.unknown_name.cursor': {
    code: -32602,
    message: 'Unknown cursor: not a name this tool issued under these filters (the catalog may have been regenerated). Restart listing without cursor.',
    reason: 'unknown_name.cursor',
    retryable: false,
  },
  'tool.unknown_name.chain': {
    code: -32602,
    message: (vars) => 'Unknown chain "' + vars.chain + '". Available: ' + vars.available,
    reason: 'unknown_name.chain',
    retryable: false,
  },
  'tool.unknown_name.chain_run': {
    code: -32602,
    message: (vars) => 'Unknown chain "' + vars.chain + '". List chains with find_chain or build_workflow_links.',
    reason: 'unknown_name.chain_run',
    retryable: false,
  },
  'tool.unknown_name.tool_id': {
    code: -32602,
    message: (vars) => 'Unknown tool_id "' + vars.toolId + '" at step ' + vars.step + '. Check mcp/catalog.json for catalog tools or chaingraph.json for ChainGraph node tool_ids.',
    reason: 'unknown_name.tool_id',
    retryable: false,
  },
  'tool.unknown_name.chaingraph_tool_id': {
    code: -32602,
    message: (vars) => 'Unknown tool_id "' + vars.toolId + '". Run build_chaingraph or inspect chaingraph.json for live node tool_ids.',
    reason: 'unknown_name.chaingraph_tool_id',
    retryable: false,
  },
  'tool.unknown_name.chaingraph_tool_ids': {
    code: -32602,
    message: (vars) => 'Unknown ChainGraph tool_id(s): ' + vars.missing + '. Call build_chaingraph with no arguments to list valid nodes.',
    reason: 'unknown_name.chaingraph_tool_ids',
    retryable: false,
  },
  'tool.unknown_name.recipe': {
    code: -32602,
    message: (vars) => 'Unknown recipe_id "' + vars.recipeId + '". Call suite_howto with NO arguments for the compact index of ' + vars.count + ' recipe ids.',
    reason: 'unknown_name.recipe',
    retryable: false,
  },
  'tool.unknown_name.dispatch': {
    code: -32602,
    message: (vars) => 'Unknown tool name "' + vars.name + '" — no such AINumbers tool; try find_tool(query) for ranked search.',
    reason: 'unknown_name.dispatch',
    retryable: false,
  },
  // GLEIF answered 404: the record deterministically does not exist (not an availability fault).
  'tool.unknown_name.gleif_record': {
    code: -32602,
    message: null,
    reason: 'unknown_name.gleif_record',
    retryable: false,
  },

  // ── lifecycle / capability (deterministic → retryable: false) ────────────────────────────────
  'tool.removed': {
    code: -32602,
    message: (vars) => 'MCP error: Tool ' + vars.toolName + ' not found (Removed)',
    reason: 'removed',
    retryable: false,
  },
  'tool.not_dispatchable': {
    code: -32602,
    message: (vars) => '"' + vars.name + '" cannot be dispatched through call_tool because it is not read-only-and-closed-world; it needs host approval, so call it directly.',
    reason: 'not_dispatchable',
    retryable: false,
  },

  // ── upstream / availability (A1: the TRUE causes) ────────────────────────────────────────────
  'tool.upstream_unavailable': {
    code: -32603,
    // Static text for the recipe-index site; the lei/egress site forwards its own text over it.
    message: 'Recipe index unavailable: data/mcp/recipes.json was not vendored. Re-run node generate.mjs in the worker repo and redeploy.',
    reason: 'upstream_unavailable',
    retryable: true,   // A1: an upstream dependency being unavailable is exactly a "retry later".
  },

  // ── §2 A3 domain-JSON entries: shape only (retryable + reason into the existing result) ──────
  // `tool.mandate_error` keeps the kernel's string-typed `error` member AS A STRING (landed spec
  // §2.2) — these entries never mint a code; they only label the existing structured object.
  'tool.mandate_error': {
    reason: 'mandate_error',
    retryable: false,
  },
  'tool.batch_budget': {
    reason: 'batch_budget',
    retryable: false,
  },
};

// ── Constructors ──────────────────────────────────────────────────────────────────────────────

// The wire object for a registered protocol error: exactly today's shape
// `{ jsonrpc:'2.0', id, error:{ code, message, ...(data?{data}:{}) } }` PLUS the one additive
// member of spec §3, `error.request_id`. `id` keeps echoing the request body's id (?? null);
// `request_id` is the per-request correlation uuid minted by mintRequestId().
export function protocolErrorBody(name, { id = null, vars = {}, requestId = null } = {}) {
  const entry = PROTOCOL_ERRORS[name];
  if (!entry) throw new Error(`errors.mjs: unregistered protocol error name: ${name}`);
  const message = typeof entry.message === 'function' ? entry.message(vars) : entry.message;
  const data = typeof entry.data === 'function' ? entry.data(vars) : entry.data;
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code: entry.code,
      message,
      ...(data !== undefined ? { data } : {}),
      // THE additive envelope members (spec §3 + BUILD-SPEC A1). request_id stays LAST so the
      // pre-envelope members keep their historical order; every existing consumer assertion is
      // equality on a SPECIFIC member and is blind to these siblings.
      retryable: entry.retryable,
      ...(requestId != null ? { request_id: requestId } : {}),
    },
  };
}

// Full Response for the call sites that construct one directly. `headers` receives the caller's
// corsHeaders (+ per-site extras like `Allow` / `Retry-After`); Content-Type stays LAST so it
// overrides exactly as the inline literals did. `status` defaults to the registered status and
// may be overridden where the worker's measured behaviour is conditional.
export function protocolErrorResponse(name, { id = null, vars = {}, requestId = null, headers = {}, status } = {}) {
  const entry = PROTOCOL_ERRORS[name];
  if (!entry) throw new Error(`errors.mjs: unregistered protocol error name: ${name}`);
  return new Response(JSON.stringify(protocolErrorBody(name, { id, vars, requestId })), {
    status: status ?? entry.status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

// The wire object for a registered TOOL error (BUILD-SPEC §2 A2): a full tool result whose
// `structuredContent.error` carries `code`, `message`, `retryable`, `data.reason` and the additive
// `request_id`, while `content[].text` stays BYTE-IDENTICAL to the pre-registry prose (the
// registry's message templates are the moved inline literals). Sites with `message: null` (a
// forwarded kernel/core exception text) pass `text`; it becomes BOTH content[].text and
// structuredContent.error.message, unaltered. ⛔ no content[].text rewrites.
export function toolErrorResult(name, { vars = {}, requestId = null, text, data } = {}) {
  const entry = TOOL_ERRORS[name];
  if (!entry) throw new Error(`errors.mjs: unregistered tool error name: ${name}`);
  if (entry.message == null && text == null) throw new Error(`errors.mjs: ${name} carries no message template — pass the forwarded text`);
  const message = text ?? (typeof entry.message === 'function' ? entry.message(vars) : entry.message);
  const out = {
    error: {
      code: entry.code,
      message,
      retryable: entry.retryable,   // A1: the cause's retry answer — validation false, availability true.
      data: { reason: entry.reason, ...(data ?? {}) },
      // THE additive envelope member (spec §3), same correlation uuid a protocol error would carry.
      ...(requestId != null ? { request_id: requestId } : {}),
    },
  };
  return { isError: true, content: [{ type: 'text', text: message }], structuredContent: out };
}

// The §2 A3 domain-JSON error (the errOut/result/report sites): the result ALREADY carries
// structure, so it gains `retryable` and the registry `reason` inside its existing structured
// object and NOTHING ELSE MOVES. `content[].text` serializes the PRE-augmentation object —
// byte-identical to today's wire text; the additive members exist only in structuredContent (the
// exact discipline ijsonErrorResult established for its envelope member).
export function toolDomainErrorResult(name, errOut) {
  const entry = TOOL_ERRORS[name];
  if (!entry) throw new Error(`errors.mjs: unregistered tool error name: ${name}`);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(errOut, null, 2) }],
    structuredContent: { ...errOut, retryable: entry.retryable, reason: entry.reason },
  };
}
