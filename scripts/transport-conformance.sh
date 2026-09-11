#!/usr/bin/env bash
# transport-conformance.sh — MCP-STREAMABLE-HTTP-CONFORMANCE-1
#
# Zero-dependency (curl + coreutils only) Streamable HTTP transport conformance for the
# AINumbers MCP door, per MCP spec 2025-03-26 / 2025-06-18 + the board row's six controls:
#   1. initialize → response carries Mcp-Session-Id
#   2. GET /mcp with Accept: text/event-stream → SSE stream, first frame within 2 s
#   3. GET /mcp without the SSE Accept → 405 with an Allow header advertising POST
#   4. DELETE /mcp with a session id → 204 (session end)
#   5. unknown MCP-Protocol-Version → 400 with a JSON-RPC error body (never a 500)
#   6. tools/list with and without cursor → same total count
#
# Usage:  bash scripts/transport-conformance.sh [BASE_URL]
#         BASE_URL defaults to http://localhost:3300 (node server.mjs, the local dev door);
#         pass https://mcp.ainumbers.co to conform the production worker after deploy.
set -u
BASE="${1:-http://localhost:3300}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok() { echo "PASS: $1"; pass=$((pass+1)); }
no() { echo "FAIL: $1"; fail=$((fail+1)); }

ACCEPT_JSON='Accept: application/json, text/event-stream'

# ── 1. initialize → Mcp-Session-Id ──────────────────────────────────────────
code=$(curl -sS -m 15 -D "$TMP/h1" -o "$TMP/b1" -w '%{http_code}' -X POST "$BASE/mcp" \
  -H 'Content-Type: application/json' -H "$ACCEPT_JSON" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"transport-conformance","version":"1.0"}}}') || true
if [ "${code:-}" = "200" ] && grep -qi '^mcp-session-id:' "$TMP/h1"; then
  ok "1 initialize → 200 + Mcp-Session-Id header"
else
  no "1 initialize → 200 + Mcp-Session-Id header (status=${code:-none}, Mcp-Session-Id absent)"
fi
SID="$(grep -i '^mcp-session-id:' "$TMP/h1" 2>/dev/null | head -1 | tr -d '\r' | awk '{print $2}')"
[ -n "$SID" ] || SID=conformance-local

# ── 2. GET /mcp SSE → first frame within 2 s (3 s ceiling; frame must already exist) ──
# The stream is session-gated (reference-SDK shape): present the session id from check 1.
curl -sS -N -m 3 -D "$TMP/h2" -o "$TMP/b2" "$BASE/mcp" -H 'Accept: text/event-stream' -H "Mcp-Session-Id: $SID" >/dev/null 2>&1 || true
ct="$(grep -i '^content-type:' "$TMP/h2" 2>/dev/null | tr -d '\r')"
if [ -s "$TMP/b2" ] && printf '%s' "$ct" | grep -qi 'text/event-stream'; then
  ok "2 GET /mcp SSE → 200 text/event-stream, first frame within 2 s"
else
  no "2 GET /mcp SSE → 200 text/event-stream, first frame within 2 s (status $(head -1 "$TMP/h2" 2>/dev/null | tr -d '\r'), ct='${ct:-none}', body $(wc -c < "$TMP/b2" 2>/dev/null || echo 0) bytes)"
fi

# ── 3. GET /mcp without the SSE Accept → 405 + Allow advertising POST ───────
code=$(curl -sS -m 10 -D "$TMP/h3" -o "$TMP/b3" -w '%{http_code}' "$BASE/mcp" -H 'Accept: application/json') || true
if [ "${code:-}" = "405" ] && grep -qi '^allow:.*POST' "$TMP/h3"; then
  ok "3 GET /mcp without SSE Accept → 405 + Allow: POST ($(grep -i '^allow:' "$TMP/h3" | tr -d '\r'))"
else
  no "3 GET /mcp without SSE Accept → 405 + Allow: POST (status=${code:-none})"
fi

# ── 4. DELETE /mcp with a session id → 204 ──────────────────────────────────
code=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -X DELETE "$BASE/mcp" -H "Mcp-Session-Id: $SID") || true
if [ "${code:-}" = "204" ]; then
  ok "4 DELETE /mcp with session id → 204"
else
  no "4 DELETE /mcp with session id → 204 (status=${code:-none})"
fi

# ── 5. unknown MCP-Protocol-Version → 400 + JSON-RPC error (never 500) ──────
code=$(curl -sS -m 15 -D "$TMP/h5" -o "$TMP/b5" -w '%{http_code}' -X POST "$BASE/mcp" \
  -H 'Content-Type: application/json' -H "$ACCEPT_JSON" -H 'MCP-Protocol-Version: 1999-01-01' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}') || true
if [ "${code:-}" = "400" ] && grep -q '"error"' "$TMP/b5"; then
  ok "5 unknown MCP-Protocol-Version → 400 + JSON-RPC error"
else
  no "5 unknown MCP-Protocol-Version → 400 + JSON-RPC error (status=${code:-none})"
fi

# ── 6. tools/list with and without cursor → same total count ────────────────
tools_list() {
  # Spec: the client's Accept MUST list both application/json and text/event-stream.
  curl -sS -m 30 -X POST "$BASE/mcp" -H 'Content-Type: application/json' -H "$ACCEPT_JSON" -d "$1"
}
tools_list '{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}' > "$TMP/t1" 2>/dev/null
tools_list '{"jsonrpc":"2.0","id":4,"method":"tools/list","params":{"cursor":"0"}}' > "$TMP/t2" 2>/dev/null
# '"name":' key count: escaped quotes inside descriptions render as \" so they cannot false-match,
# and both sides count identically, so the comparison is exact even where nested schemas add keys.
c1=$(grep -o '"name" *:' "$TMP/t1" 2>/dev/null | wc -l | tr -d ' ')
c2=$(grep -o '"name" *:' "$TMP/t2" 2>/dev/null | wc -l | tr -d ' ')
if [ "${c1:-0}" -gt 0 ] && [ "$c1" = "$c2" ]; then
  ok "6 tools/list with and without cursor → same total count ($c1 tool-name keys each)"
else
  no "6 tools/list with and without cursor → same total count ($c1 vs $c2)"
fi

echo "--------------------------------------------------------------"
echo "transport-conformance vs $BASE — $pass passed, $fail failed"
[ "$fail" -eq 0 ]
