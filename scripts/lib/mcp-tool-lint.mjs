// mcp-tool-lint.mjs — shared MCP tool-definition lint/score logic (M2.1, dogfood gate).
//
// Ported verbatim (logic-identical, DOM stripped) from the SITE's live tool
// `lint_mcp_tool_definition` (art-274, data/tools/274-mcp-tool-definition-linter.html,
// function lintToolDef/scoreOf). That HTML kernel's execution_type is
// "browser-reference" — it has no server-callable *.kernel.mjs, so it cannot be
// invoked over a real tools/call round-trip from CI. This module is the SAME
// pure-function ruleset, extracted so the description-quality CI gate genuinely
// dogfoods the suite's own rules rather than a parallel re-implementation.
// If lintToolDef/scoreOf change in the site tool, mirror the change here.

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const ANN_KEYS = { title: 'string', readOnlyHint: 'boolean', destructiveHint: 'boolean', idempotentHint: 'boolean', openWorldHint: 'boolean' };

function F(level, msg, cite) { return { level, msg, cite: cite || null }; }

function lintSchema(s, path, out, depth) {
  depth = depth || 0;
  if (depth > 8) { out.push(F('warn', path + ': schema nesting exceeds 8 levels — bound depth; deep schemas raise validation cost and DoS risk.', 4)); return; }
  if (s.$ref && /^https?:\/\//i.test(s.$ref)) out.push(F('error', path + ': external $ref "' + s.$ref + '" — implementations MUST NOT auto-dereference external $ref URIs. Use local $defs.', 4));
  if (depth === 0 && s.$schema && !/2020-12/.test(s.$schema)) out.push(F('warn', path + ': $schema dialect is not 2020-12 — 2020-12 is the MCP default dialect since 2025-11-25.', 1));
  if ('required' in s && !Array.isArray(s.required)) out.push(F('error', path + ': "required" must be an array of property-name strings.', 1));
  if (Array.isArray(s.required) && s.properties) {
    s.required.forEach(function (r) { if (!(r in s.properties)) out.push(F('error', path + ': "required" lists "' + r + '" which is not defined in properties.', 1)); });
  }
  if (s.properties && typeof s.properties === 'object') {
    Object.keys(s.properties).forEach(function (k) {
      const p = s.properties[k];
      if (p && typeof p === 'object') {
        const hasType = ('type' in p) || p.$ref || p.enum || p.oneOf || p.anyOf || p.allOf || p.const;
        if (!hasType) out.push(F('warn', path + '.' + k + ': no "type"/enum/$ref/combinator — agents reason poorly about untyped parameters.', 1));
        if (!p.description) out.push(F('warn', path + '.' + k + ': missing "description" — parameter descriptions materially improve tool-call accuracy.', 1));
        lintSchema(p, path + '.' + k, out, depth + 1);
      }
    });
  }
  if (s.items && typeof s.items === 'object') lintSchema(s.items, path + '[]', out, depth + 1);
}

function lintAnnotations(a, out) {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) { out.push(F('error', '"annotations" must be an object.', 3)); return; }
  Object.keys(a).forEach(function (k) {
    if (!(k in ANN_KEYS)) out.push(F('warn', 'annotations.' + k + ': not a recognised annotation. Valid: title, readOnlyHint, destructiveHint, idempotentHint, openWorldHint.', 3));
    else if (typeof a[k] !== ANN_KEYS[k]) out.push(F('error', 'annotations.' + k + ' must be a ' + ANN_KEYS[k] + '.', 3));
  });
  if (a.readOnlyHint === true && a.destructiveHint === true) out.push(F('error', 'Contradiction: readOnlyHint:true with destructiveHint:true — a read-only tool cannot be destructive.', 3));
  if (a.readOnlyHint === true && 'destructiveHint' in a && a.destructiveHint === false) out.push(F('warn', 'destructiveHint is only meaningful for non-read-only tools; on a read-only tool it is moot (drop it).', 3));
  if (a.readOnlyHint === true && 'idempotentHint' in a) out.push(F('warn', 'idempotentHint is only meaningful for non-read-only tools; on a read-only tool it is moot (drop it).', 3));
  out.push(F('pass', "annotations present — remember these are advisory hints, never security controls; clients must not make trust decisions from an untrusted server's annotations.", 2));
}

export function lintToolDef(obj) {
  const out = [];
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) { out.push(F('error', 'Top-level value must be a single tool-definition object.', 1)); return out; }
  if (!('name' in obj)) out.push(F('error', 'Missing required "name".', 1));
  else if (typeof obj.name !== 'string' || !obj.name) out.push(F('error', '"name" must be a non-empty string.', 1));
  else {
    if (!NAME_RE.test(obj.name)) out.push(F('warn', '"name" ("' + obj.name + '") should be snake_case, matching ^[a-z][a-z0-9_]*$ per tool-naming guidance (SEP-986).', 1));
    else out.push(F('pass', '"name" is well-formed snake_case.', 1));
    if (obj.name.length > 64) out.push(F('warn', '"name" is ' + obj.name.length + ' chars — keep tool names short and stable.', 1));
  }
  if (!obj.description || typeof obj.description !== 'string') out.push(F('error', 'Missing or empty "description" — clients surface this to the model to decide when to call the tool.', 1));
  else if (obj.description.length < 16) out.push(F('warn', '"description" is very short (' + obj.description.length + ' chars) — describe when and why an agent should call this tool.', 1));
  else out.push(F('pass', '"description" present (' + obj.description.length + ' chars).', 1));
  if (!('inputSchema' in obj)) out.push(F('error', 'Missing required "inputSchema".', 1));
  else {
    const s = obj.inputSchema;
    if (typeof s !== 'object' || s === null || Array.isArray(s)) out.push(F('error', '"inputSchema" must be a JSON Schema object.', 1));
    else {
      if (s.type !== 'object') out.push(F('error', '"inputSchema" root MUST have type:"object" (MCP requirement).', 1));
      else out.push(F('pass', 'inputSchema root is type:"object".', 1));
      lintSchema(s, 'inputSchema', out, 0);
    }
  }
  if ('outputSchema' in obj) {
    const os = obj.outputSchema;
    if (typeof os !== 'object' || os === null || Array.isArray(os)) out.push(F('error', '"outputSchema" must be a JSON Schema object when present.', 1));
    else {
      if (os.type !== 'object') out.push(F('warn', '"outputSchema" root is conventionally type:"object" — it defines the structuredContent clients validate.', 1));
      else out.push(F('pass', 'outputSchema present (root type:"object") → structuredContent will be schema-validated by clients.', 1));
      lintSchema(os, 'outputSchema', out, 0);
    }
  } else {
    out.push(F('warn', 'No "outputSchema" — consider declaring one so clients can validate structuredContent (added 2025-06-18).', 1));
  }
  if ('annotations' in obj) lintAnnotations(obj.annotations, out);
  else out.push(F('warn', 'No "annotations" — add readOnlyHint / destructiveHint / idempotentHint / openWorldHint to describe behaviour (advisory only).', 3));
  return out;
}

export function scoreOf(findings) {
  let e = 0, w = 0, p = 0;
  findings.forEach(function (f) { if (f.level === 'error') e++; else if (f.level === 'warn') w++; else p++; });
  let sc = 100 - e * 15 - w * 4;
  if (sc < 0) sc = 0; if (sc > 100) sc = 100;
  return { score: sc, e, w, p };
}
