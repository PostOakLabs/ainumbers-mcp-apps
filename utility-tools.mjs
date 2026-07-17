// SINGLE SOURCE OF TRUTH for the worker's utility (non-node, non-pilot) MCP tool names.
//
// WHY: before this module the utility set / its count was hardcoded in 3+ independent places
// (generate.mjs UTIL_TOOL_COUNT, scripts/surface-parity.mjs EXPECTED_UTIL, the tools/call known-set
// + build-mcp-parity mirror). Adding one utility tool (e.g. run_chain, 2026-06-29) meant editing all
// of them, and the live-count assertion only ran POST-DEPLOY — so a missed spot shipped a bad deploy
// and a red count-drift gate. Everything now derives from this one list; build-mcp-parity additionally
// asserts counts.json.mcp_tools_total === the actual registered tool count BEFORE deploy.
//
// To add a utility tool: register it in worker.mjs buildServer, add its name here, and (if it should
// never defer) to HOT_TOOLS. The count flows everywhere automatically.
export const UTILITY_TOOL_NAMES = [
  'list_ainumbers_tools',
  'build_workflow_links',
  'verify_execution_hash',
  'build_chaingraph',
  'emit_chaingraph_artifact',
  'build_session_receipt',
  'export_artifact',
  'find_chain',
  'find_tool',
  'run_chain',
  'validate_input_attestations',
  'suggest_tool_idea',
  'vc_issue',
  'sdjwt_issue',
  'sdjwt_present',
  'checklist_validate_definition',
  'checklist_step_receipt',
  'checklist_verify_run',
  'intoto_record_chain_run',
  'build_disclosure_manifest',
  'verify_disclosure_inclusion',
];

export const UTILITY_TOOL_COUNT = UTILITY_TOOL_NAMES.length;
