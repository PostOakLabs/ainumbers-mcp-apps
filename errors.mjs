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
//   - Members are only ever ADDED. The one additive delta of this module is `error.request_id`
//     (spec §3): a fresh correlation uuid per request. The JSON-RPC `id` member keeps echoing
//     body.id exactly as before — `request_id` is CORRELATION, `id` is REPLY ADDRESSING.
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
  },

  // WORKER-IDREPLACE-DOS-1 P1-1: JSON-RPC batching removed in MCP revision 2025-06-18.
  'protocol.invalid_request.batching': {
    code: -32600, status: 400,
    message: 'Invalid Request: JSON-RPC batching is not supported (removed in MCP revision 2025-06-18). Send one request per POST.',
  },

  // JSON-RPC 2.0 §4: a PRESENT id must be a string, number, or null.
  'protocol.invalid_request.id_type': {
    code: -32600, status: 400,
    message: 'Invalid Request: "id" must be a string, number, or null (JSON-RPC 2.0 §4)',
  },

  // Body over MAX_REQUEST_BODY_BYTES. ONE name, THREE call sites (the /access/v1 cap response and
  // the two /mcp pre-parse caps) — each keeps its own measured status via the site.
  'protocol.invalid_request.body_too_large': {
    code: -32600, status: 413,
    message: (vars) => `Invalid Request: body exceeds the ${vars.limit}-byte limit`,
  },

  'protocol.method_not_allowed.post_guidance': {
    code: -32601, status: 405,
    message: 'Method Not Allowed: use POST for JSON-RPC, or GET with Accept: text/event-stream and your Mcp-Session-Id (from initialize) for the server-to-client stream.',
  },

  'protocol.method_not_allowed.delete_guidance': {
    code: -32601, status: 405,
    message: 'Method Not Allowed: DELETE ends a session and requires the Mcp-Session-Id header issued at initialize. Use POST for JSON-RPC.',
  },

  // Single-endpoint rule: the legacy /sse + /messages transport paths are gone (2026-09-11 probe).
  'protocol.method_not_allowed.no_sse_path': {
    code: -32601, status: 405,
    message: 'Method Not Allowed: the MCP endpoint is POST /mcp (Streamable HTTP); there is no separate SSE path. GET /mcp with Accept: text/event-stream opens the server-to-client stream.',
  },

  // Unknown RPC method short-circuit (MW2-UNKNOWN-METHOD-GUARD-1). Status is OVERRIDDEN at the
  // call site: modern era → 404, legacy → 200 (smoke-mcp §3/§3b controls assert both; the blanket
  // 200 once regressed the modern leg — worker #306).
  'protocol.method_not_found.unknown_method': {
    code: -32601, status: 200,
    message: (vars) => 'Method not found: ' + vars.method,
  },

  // MCP728-CONFORM-FIX-2: an explicit MODERN protocol-version assertion outside the supported set.
  // data shape frozen ({ supported, requested }). -32022, never the SDK's generic -32000.
  'protocol.unsupported_protocol_version': {
    code: -32022, status: 400,
    message: (vars) => `Unsupported protocol version: ${vars.requested}`,
    data: (vars) => ({ supported: vars.supported, requested: vars.requested }),
  },

  // Mcp-Protocol-Version header missing/mismatched (SEP-2243 routing). History (spec §1): this
  // condition was originally -32001 and was RENUMBERED to -32020 by modelcontextprotocol#2907 —
  // nobody "restores" the old mapping; -32001 now means ONLY the watchdog timeout below.
  'protocol.header_mismatch': {
    code: -32020, status: 400,
    message: (vars) => `Header mismatch: ${vars.detail}`,
  },

  // -32021: wired, but REQUIRED_CLIENT_CAPABILITIES is empty, so unreachable today (worker.mjs
  // measures this). Registered anyway so the day it goes live it is already named.
  'protocol.missing_client_capability': {
    code: -32021, status: 400,
    message: (vars) => 'Missing required client capability: ' + vars.lacking.join(', '),
    data: (vars) => ({ requiredCapabilities: vars.lacking }),
  },

  // §2.3 DOCTRINE: throttle is never conflated. -32029 is a TRANSPORT-AVAILABILITY condition —
  // it fires pre-parse, before any validation, and its remedy is time, not input correction. It
  // must never share a code, a message, or a code path with protocol.invalid_params.* (-32602) or
  // protocol.missing_client_capability (-32021), and vice versa. The gate reds any -32029 emitted
  // from anywhere but this entry's single call site (the limiter short-circuit).
  'protocol.rate_limited': {
    code: -32029, status: 429,
    message: 'Rate limit exceeded. Wait and retry.',
  },

  // Per-request modern-era protocol fields (missingRequiredMeta). data.missingFields carries the
  // RAW array; the message carries the join — exactly as the inline original did.
  'protocol.invalid_params.protocol_fields': {
    code: -32602, status: 400,
    message: (vars) => 'Invalid params: request _meta is missing required field(s): ' + vars.missing.join(', '),
    data: (vars) => ({ missingFields: vars.missing }),
  },

  // Static fast-path list cursor (buildListPage): token is not one this server issued.
  'protocol.invalid_params.cursor': {
    code: -32602, status: 400,
    message: 'Invalid params: cursor is not a valid page token (echo the nextCursor this server issued)',
  },

  // SDK fallback-path list cursor (parseToolsCursorOffset): different grammar, same code, OWN name
  // (spec §2.1: two cursor texts, two names, one code — the two never interpret the same token).
  'protocol.invalid_params.sdk_cursor': {
    code: -32602, status: 400,
    message: 'Invalid params: unknown cursor (this server issues decimal-offset cursors via nextCursor)',
  },

  // describe_tool O(1) path: the `{ name: string }` argument precondition.
  'protocol.invalid_params.describe_tool_args': {
    code: -32602, status: 400,
    message: 'Invalid params: describe_tool requires { name: string } — the mcp_name to describe',
  },

  // Unknown tool name, answered at the dispatch layer WITHOUT the full ~186-tool build
  // (MCP-728 T2). The `-32602` tool-not-found texts must keep their `Tool not found:` prefix
  // (gate-enforced).
  'protocol.tool_not_found.zero_tools': {
    code: -32602, status: 200,
    message: (vars) => 'Tool not found: ' + vars.toolName,
  },

  // describe_tool unknown name + BM25/edit-distance nearest names (data shape frozen).
  'protocol.tool_not_found.nearest': {
    code: -32602, status: 200,
    message: (vars) => 'Tool not found: describe_tool("' + vars.name + '") — no registered mcp_name by that name',
    data: (vars) => ({ nearest_names: vars.nearest, hint: vars.hint }),
  },

  // Watchdog "Server timeout" — the ONLY thing -32001 means today (see header_mismatch history).
  'protocol.server_timeout': {
    code: -32001, status: 504,
    message: 'Server timeout',
  },

  // Internal error — constant text; the exception detail + stack go to console.error ONLY.
  'protocol.internal_error': {
    code: -32603, status: 500,
    message: 'Internal error',
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
export const TOOL_ERRORS = {
  'tool.ijson_violation': {
    code: -32602,
    message: 'Invalid params: input is not I-JSON, so it has no stable canonical form and cannot be hashed.',
    reason: 'ijson_violation',
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
      // THE additive envelope member (spec §3). Last so the pre-envelope members keep their
      // historical order; every existing consumer assertion is equality on a SPECIFIC member and
      // is blind to this sibling.
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
