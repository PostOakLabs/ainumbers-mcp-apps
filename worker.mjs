// AINumbers MCP Apps server -- Cloudflare Workers runtime.
// Same tool surface as server.mjs (Render/express); stateless streamable-HTTP via fetch-to-node.
// Deploy: npx wrangler deploy   (data/ vendored by generate.mjs is served via the ASSETS binding)
// Test locally: node test-worker.mjs (simulates the Workers env in plain Node)

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { toReqRes, toFetchResponse } from 'fetch-to-node';
import { registerAppTool, registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { PILOT } from './pilot.mjs';

const BASE_URL = 'https://ainumbers.co';

// ---------------------------------------------------------------------------
// build_workflow_links -- named chain definitions
// Steps keyed by file slug (filename without .html). handoff describes which
// upstream outputs the next step consumes. composer_url present when a live
// Runner page orchestrates the chain.
// ---------------------------------------------------------------------------
const NAMED_CHAINS = {
  // Live composers
  'aml-programme': {
    title: 'AML Programme',
    description: 'Customer risk rating > TM rule building > CTR/SAR thresholds > AML Policy Mandate. Full audited run available in the composer.',
    composer_url: BASE_URL + '/guides/aml-programme-composer.html',
    steps: [
      { slug: '110-customer-risk-rating',          handoff: 'risk_tier and composite_score feed Stage 2 TM rule calibration' },
      { slug: '116-tm-rule-builder',               handoff: 'rule_set and velocity_thresholds feed Stage 3 CTR/SAR simulation' },
      { slug: '119-ctr-sar-threshold-simulator',   handoff: 'threshold_values and alert_triggers feed Stage 4 mandate payload' },
      { slug: '131-ap2-aml-mandate-builder',       handoff: 'Exports composite AML Policy Mandate -- final stage' },
    ],
  },
  'card-programme': {
    title: 'Card Programme',
    description: 'Launch readiness > interchange qualification > PCI-DSS scope > 3DS/EMV compliance > scheme fee benchmarking.',
    composer_url: BASE_URL + '/guides/card-programme-composer.html',
    steps: [
      { slug: '163-card-programme-launch-readiness-checker',   handoff: 'readiness_score and gap_list feed Stage 2 interchange qualification' },
      { slug: '225-visa-mc-interchange-qualification-tester',  handoff: 'ic_category and qualification_flags feed Stage 3 PCI scope' },
      { slug: '226-pci-dss-v4-scope-wizard',                   handoff: 'scope_components and cde_boundaries feed Stage 4 3DS/EMV check' },
      { slug: '228-3ds-emv-compliance-checker',                handoff: 'compliance_status and exemptions feed Stage 5 scheme benchmarking' },
      { slug: '233-card-scheme-fee-benchmarking',              handoff: 'Exports card programme Policy Mandate -- final stage' },
    ],
  },
  'iso20022-cutover': {
    title: 'ISO 20022 Cutover',
    description: 'Truncation audit > migration score > cross-rail compatibility check.',
    composer_url: BASE_URL + '/guides/iso20022-cutover-composer.html',
    steps: [
      { slug: '77-iso-truncation-auditor',             handoff: 'truncation_risks and field_map feed Stage 2 migration scoring' },
      { slug: '101-iso20022-migration-scorer',         handoff: 'migration_score and readiness_flags feed Stage 3 cross-rail check' },
      { slug: '254-iso20022-cross-rail-compatibility', handoff: 'Exports ISO 20022 cutover Policy Mandate -- final stage' },
    ],
  },
  'agentic-policy': {
    title: 'Agentic Policy',
    description: 'Agentic mandate sandbox > Google AP2 mandate builder > AP2/MCP policy validator > MCP developer readiness scorecard.',
    composer_url: BASE_URL + '/guides/policy-composer.html',
    steps: [
      { slug: 'rbe-06-agentic-mandate-sandbox',        handoff: 'mandate_draft and guardrail_flags feed Stage 2 AP2 mandate build' },
      { slug: '285-google-ap2-mandate-builder',        handoff: 'ap2_mandate and payment_policy feed Stage 3 policy validation' },
      { slug: '320-ap2-mcp-policy-validator',          handoff: 'validation_results and policy_gaps feed Stage 4 readiness scorecard' },
      { slug: '288-mcp-developer-readiness-scorecard', handoff: 'Exports agentic policy composite mandate -- final stage' },
    ],
  },
  'treasury-corridor': {
    title: 'Treasury Corridor',
    description: 'FX netting simulation > FX hedge optimisation > corridor savings calculation.',
    composer_url: BASE_URL + '/guides/treasury-corridor-composer.html',
    steps: [
      { slug: '105-fx-netting-simulator', handoff: 'netting_savings and net_exposure feed Stage 2 hedge optimisation' },
      { slug: '76-fx-hedge-optimizer',    handoff: 'hedge_ratio and instrument_mix feed Stage 3 corridor savings model' },
      { slug: '23-corridor-savings-calc', handoff: 'Exports treasury corridor Policy Mandate -- final stage' },
    ],
  },
  // tool-chains.html prose chains
  'cbpr-cutover': {
    title: 'CBPR+ Cutover Validation',
    description: 'Validate message structure, remittance mapping, cross-rail compatibility, and schema compliance before SWIFT CBPR+ go-live.',
    steps: [
      { slug: '02-iso20022-builder',                    handoff: 'generated_xml and validation_status feed T144 remittance validation' },
      { slug: '144-iso20022-remittance-validator',      handoff: 'remittance_fields and mapping_errors feed T254 cross-rail check' },
      { slug: '254-iso20022-cross-rail-compatibility',  handoff: 'compatibility_matrix and gap_list feed T98 schema validation' },
      { slug: '98-iso20022-validator',                  handoff: 'Exports ISO 20022 validation Policy Mandate -- final stage' },
    ],
  },
  'rtp-participation': {
    title: 'Real-Time Rail Participation',
    description: 'Score FedNow/RTP participation readiness, check network rules, size intraday credit, and build the AP2 policy mandate.',
    steps: [
      { slug: '255-fednow-participation-readiness-scorer', handoff: 'readiness_score and gap_items feed T229 RTP network rule check' },
      { slug: '229-rtp-network-participation-checker',     handoff: 'rule_compliance and membership_flags feed T258 intraday credit sizing' },
      { slug: '258-intraday-credit-facility-sizer',        handoff: 'credit_requirement and peak_exposure feed T259 AP2 policy build' },
      { slug: '259-ap2-rtp-policy-builder',                handoff: 'Exports RTP participation Policy Mandate -- final stage' },
    ],
  },
  'sca-consent-fapi': {
    title: 'SCA, Consent, and FAPI Compliance',
    description: 'Map SCA exemptions, build consent scope, validate FAPI security profile, and generate consent receipts.',
    steps: [
      { slug: '92-sca-exemption-mapper',      handoff: 'exemption_map and risk_scores feed T91 consent scope builder' },
      { slug: '91-consent-dashboard-builder', handoff: 'consent_scope and framework_flags feed T97 FAPI validation' },
      { slug: '97-fapi-security-validator',   handoff: 'fapi_profile and security_gaps feed T96 consent receipt generation' },
      { slug: '96-consent-receipt-generator', handoff: 'Exports SCA/consent/FAPI Policy Mandate -- final stage' },
    ],
  },
  'dora-readiness': {
    title: 'DORA ICT Risk to NCA Submission',
    description: 'Gap analysis > resilience testing design > proportionality assessment > AP2 DORA Policy Mandate. Composer coming soon.',
    steps: [
      { slug: '300-dora-ict-risk-gap-analyser',       handoff: 'gap_findings and ict_risk_score feed T304 resilience testing design' },
      { slug: '304-dora-resilience-testing-designer', handoff: 'testing_plan and tlpt_scope feed T307 proportionality assessment' },
      { slug: '307-dora-proportionality-assessment',  handoff: 'proportionality_tier and obligations feed T310 policy mandate build' },
      { slug: '310-ap2-dora-policy-mandate-builder',  handoff: 'Exports DORA ICT risk Policy Mandate -- final stage' },
    ],
  },
  'transaction-screening': {
    title: 'Transaction Screening and Rule-Building',
    description: 'Sanctions screening > FATF travel rule > fraud investigation.',
    steps: [
      { slug: '43-batch-sanctions-screening', handoff: 'screening_results and hit_list feed T222 travel rule check' },
      { slug: '222-fatf-travel-rule-checker', handoff: 'travel_rule_status and originator_flags feed T80 fraud investigation' },
      { slug: '80-fraud-investigation-lab',   handoff: 'Exports transaction screening Policy Mandate -- final stage' },
    ],
  },
  'regulatory-impact': {
    title: 'Regulatory Impact to Policy Mandate',
    description: 'Regulatory change impact assessment > NIS2/DORA overlap mapping > AP2 DORA Policy Mandate.',
    steps: [
      { slug: '318-regulatory-change-impact-assessor', handoff: 'impact_domains and change_timeline feed T309 NIS2/DORA overlap map' },
      { slug: '309-nis2-dora-overlap-mapper',          handoff: 'overlap_matrix and dual_obligations feed T310 policy mandate build' },
      { slug: '310-ap2-dora-policy-mandate-builder',   handoff: 'Exports regulatory impact Policy Mandate -- final stage' },
    ],
  },
  'fx-corridor': {
    title: 'Corridor Cost and Failure Analysis',
    description: 'FX margin transparency > cross-border failure modelling > corridor cost ranking > payment corridor optimisation.',
    steps: [
      { slug: '209-fx-margin-cost-transparency',        handoff: 'margin_breakdown and all-in-cost feed T210 failure modelling' },
      { slug: '210-cross-border-payment-failure-model', handoff: 'failure_rates and root_causes feed T216 corridor cost ranking' },
      { slug: '216-corridor-cost-ranker',               handoff: 'corridor_ranking and cost_delta feed T95 optimisation' },
      { slug: '95-payment-corridor-optimizer',          handoff: 'Exports FX corridor Policy Mandate -- final stage' },
    ],
  },
  'pd-lgd-covenant': {
    title: 'PD, LGD, EAD to Covenant Compliance',
    description: 'Credit risk parameter modelling > Basel RWA calculation > financial covenant compliance check.',
    steps: [
      { slug: '198-pd-lgd-ead-modeller',                   handoff: 'pd, lgd, ead values feed T201 Basel RWA calculation' },
      { slug: '201-basel-rwa-calculator',                  handoff: 'rwa_total and capital_requirement feed T199 covenant compliance' },
      { slug: '199-financial-covenant-compliance-checker', handoff: 'Exports credit risk Policy Mandate -- final stage' },
    ],
  },
  'stablecoin-reserve': {
    title: 'GENIUS Act / MiCA Reserve Compliance',
    description: 'Reserve portfolio optimisation > smart contract validation > RWA tokenisation cost modelling.',
    steps: [
      { slug: '328-genius-act-reserve-optimizer', handoff: 'reserve_composition and compliance_status feed T54 smart contract validation' },
      { slug: '54-smart-contract-validator',      handoff: 'contract_audit and risk_flags feed T66 RWA tokenisation cost model' },
      { slug: '66-rwa-tokenization-cost-model',   handoff: 'Exports stablecoin reserve Policy Mandate -- final stage' },
    ],
  },
  'baas-programme': {
    title: 'BaaS Provider Selection to Compliance Mapping',
    description: 'BaaS provider scoring > embedded lending unit economics > compliance control mapping > B2B fraud detection.',
    steps: [
      { slug: '152-baas-provider-comparator',          handoff: 'provider_scores and selection_rationale feed T160 unit economics' },
      { slug: '160-embedded-lending-unit-economics',   handoff: 'unit_economics and margin_drivers feed T158 compliance mapping' },
      { slug: '158-fintech-compliance-control-mapper', handoff: 'control_gaps and framework_obligations feed T140 fraud detection' },
      { slug: '140-b2b-payment-fraud-detector',        handoff: 'Exports BaaS programme Policy Mandate -- final stage' },
    ],
  },
  'card-interchange': {
    title: 'Interchange Optimisation to Scheme Compliance',
    description: 'Interchange optimisation > Visa/MC qualification testing > scheme fee benchmarking > 3DS/EMV compliance.',
    steps: [
      { slug: '52-interchange-optimizer',                     handoff: 'optimal_mcc and routing_strategy feed T225 qualification testing' },
      { slug: '225-visa-mc-interchange-qualification-tester', handoff: 'ic_category and qualification_flags feed T233 scheme fee benchmarking' },
      { slug: '233-card-scheme-fee-benchmarking',             handoff: 'fee_delta and scheme_comparison feed T228 3DS/EMV compliance' },
      { slug: '228-3ds-emv-compliance-checker',               handoff: 'Exports card interchange Policy Mandate -- final stage' },
    ],
  },
};

// base64url-encode a plain object into an #in= fragment value.
function base64urlEncode(obj) {
  const json = JSON.stringify(obj);
  // encodeURIComponent + unescape gives a Latin-1 string safe for btoa
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Widget-side glue: drives the AIN Bridge already inside every tool.
// The ext-apps SDK is INLINED (vendored by generate.mjs as data/ext-apps-inline.js): the widget
// sandbox CSP and the tools' own CSP meta both block third-party CDN imports (esm.sh), which
// left app.connect() never firing and the widget iframe stuck invisible at its placeholder size.
const widgetGlue = (sdkInline) => `
<script type="module">
${sdkInline}
const { App } = globalThis.__EXT_APPS__;
const app = new App({ name: 'ainumbers-widget', version: '1.0.0' });
app.ontoolresult = (result) => {
  try {
    const inputs = result?.structuredContent?.inputs ?? {};
    if (window.AINBridge) {
      const n = window.AINBridge.apply(inputs);
      if (n > 0) window.AINBridge.run();
    }
  } catch (e) { /* widget stays interactive regardless */ }
};
await app.connect();
</script>`;

// The vendored tool pages ship a strict CSP meta for serving on ainumbers.co; inside the host's
// sandboxed widget iframe it would fight the inline glue. The host enforces its own CSP -- strip ours.
const stripCspMeta = (html) => html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\s*/i, '');

// Module-scope cache: assets are immutable per deploy, so load once per isolate.
let dataCache = null;
async function loadData(env) {
  if (dataCache) return dataCache;
  const get = async (path) => {
    const r = await env.ASSETS.fetch('https://assets.local/' + path);
    if (!r.ok) throw new Error('asset miss: ' + path + ' > ' + r.status);
    return r;
  };
  const glue = widgetGlue(await (await get('ext-apps-inline.js')).text());
  const manifests = {}, widgets = {};
  for (const slug of PILOT) {
    manifests[slug] = await (await get('manifests/' + slug + '.manifest.json')).json();
    widgets[slug] = stripCspMeta(await (await get('tools/' + slug + '.html')).text()) + glue;
  }
  const catalog = await (await get('mcp/catalog.json')).json();
  dataCache = { manifests, widgets, catalog };
  return dataCache;
}

function buildServer({ manifests, widgets, catalog }) {
  const server = new McpServer({ name: 'ainumbers-apps', version: '0.4.0' });

  for (const slug of PILOT) {
    const m = manifests[slug];
    const uri = 'ui://ainumbers/' + slug;
    const name = m.mcp_tool_definition?.name ?? slug.replace(/-/g, '_');

    registerAppTool(server, name, {
      title: m.title,
      description: (m.mcp_tool_definition?.description ?? m.description) +
        ' Renders the interactive AINumbers tool as a widget; inputs are applied via the AIN Bridge and the tool runs client-side (zero PII, zero network).',
      inputSchema: { inputs: z.record(z.any()).optional()
        .describe('Map of tool input element IDs to values (see manifest input_schema). Applied via AIN Bridge prefill.') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: { ui: { resourceUri: uri } },
    }, async ({ inputs }) => ({
      content: [{ type: 'text', text: 'Opened ' + m.title + '. ' + (inputs ? Object.keys(inputs).length + ' inputs applied via AIN Bridge.' : 'Configure inputs in the widget.') + ' Tool runs deterministically in the widget sandbox; export a Policy Mandate for the audit trail.' }],
      structuredContent: { tool_id: m.tool_id, version: m.version, inputs: inputs ?? {}, url: BASE_URL + '/tools/' + slug + '.html' },
    }));

    registerAppResource(server, m.title, uri, {}, async () => ({
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: widgets[slug] }],
    }));
  }

  server.registerTool('list_ainumbers_tools', {
    title: 'List AINumbers tools',
    description: 'Search the AINumbers catalog (420+ client-side fintech tools). Returns deep-links; prefill-enabled tools accept #in=<base64url(JSON of {element_id: value})>[&run=1] for one-click invocation.',
    inputSchema: { query: z.string().optional(), category: z.string().optional(), limit: z.number().optional() },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ query, category, limit }) => {
    const q = (query ?? '').toLowerCase();
    const rows = (catalog.tools ?? [])
      .filter((t) => !category || t.metadata?.category === category)
      .filter((t) => !q || (t.name + ' ' + t.description).toLowerCase().includes(q))
      .slice(0, limit ?? 20)
      .map((t) => ({ name: t.name, tool_id: t.metadata?.tool_id, url: t.metadata?.url, prefill: !!t.metadata?.prefill, ap2_export: !!t.metadata?.ap2_export, description: t.description.slice(0, 160) }));
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }], structuredContent: { count: rows.length, tools: rows } };
  });

  // build_workflow_links
  // Build a slug-indexed and tool_id-indexed lookup from the catalog.
  // Done once inside buildServer (catalog is already loaded).
  const bySlug = {}, byToolId = {};
  for (const t of catalog.tools ?? []) {
    const url = t.metadata?.url ?? '';
    const slug = url.split('/').pop().replace('.html', '');
    if (slug) bySlug[slug] = t;
    if (t.metadata?.tool_id) byToolId[t.metadata.tool_id] = t;
  }

  server.registerTool('build_workflow_links', {
    title: 'Build AINumbers workflow deep-links',
    description:
      'Constructs an ordered set of ready-to-use deep-links for a named AINumbers workflow chain ' +
      'or an ad-hoc sequence of tools. Each link points directly to the browser tool; ' +
      'prefill-enabled steps accept #in=<base64url(JSON)> fragments so the tool opens pre-filled. ' +
      'Zero server-side execution -- all tool logic runs deterministically in the user\'s browser. ' +
      'Use this to hand a user a complete workflow: open step 1, run it, export its Policy Mandate, ' +
      'open step 2 (pre-filled from step 1 outputs), repeat. ' +
      'Named chains: ' + Object.keys(NAMED_CHAINS).join(', ') + '.',
    inputSchema: {
      chain: z.string().optional().describe(
        'Name of a pre-defined chain. One of: ' + Object.keys(NAMED_CHAINS).join(', ') +
        '. Mutually exclusive with steps.'
      ),
      steps: z.array(z.object({
        tool_id: z.string().describe('Tool slug or tool_id (e.g. "110-customer-risk-rating" or "a2a-fee-calculator")'),
        fields: z.record(z.any()).optional().describe('Input element ID to value map; encoded as #in= fragment in the returned URL'),
      })).optional().describe('Ad-hoc ordered step list. Mutually exclusive with chain.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ chain, steps }) => {
    const warnings = [];

    // Resolve step list
    let chainMeta = null;
    let rawSteps;
    if (chain && steps) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Provide either chain or steps, not both.' }],
      };
    }
    if (chain) {
      chainMeta = NAMED_CHAINS[chain];
      if (!chainMeta) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Unknown chain "' + chain + '". Available: ' + Object.keys(NAMED_CHAINS).join(', ') }],
        };
      }
      rawSteps = chainMeta.steps.map((s) => ({ tool_id: s.slug, fields: undefined, _handoff: s.handoff }));
    } else if (steps && steps.length > 0) {
      rawSteps = steps.map((s) => ({ tool_id: s.tool_id, fields: s.fields, _handoff: null }));
    } else {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Provide chain (named) or steps (ad-hoc array of {tool_id, fields?}).' }],
      };
    }

    // Build output steps
    const result = [];
    for (let i = 0; i < rawSteps.length; i++) {
      const rs = rawSteps[i];
      // Look up by slug first, then by tool_id
      const entry = bySlug[rs.tool_id] ?? byToolId[rs.tool_id];
      if (!entry) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Unknown tool_id "' + rs.tool_id + '" at step ' + (i + 1) + '. Check mcp/catalog.json for valid slugs/tool_ids.' }],
        };
      }
      const prefill = !!entry.metadata?.prefill;
      let url = entry.metadata?.url ?? (BASE_URL + '/tools/' + rs.tool_id + '.html');
      // Append #in= fragment if fields provided
      if (rs.fields && Object.keys(rs.fields).length > 0) {
        if (!prefill) {
          warnings.push('Step ' + (i + 1) + ' (' + rs.tool_id + '): fields provided but tool is not prefill-enabled -- fields ignored.');
        } else {
          url = url + '#in=' + base64urlEncode(rs.fields);
        }
      }
      // Named chain handoff note; for ad-hoc, generate a generic note
      let handoff_note = rs._handoff;
      if (!handoff_note && i < rawSteps.length - 1) {
        handoff_note = 'Export the Policy Mandate from this tool, then open step ' + (i + 2) + '.';
      } else if (!handoff_note) {
        handoff_note = 'Final step -- export the Policy Mandate for your audit trail.';
      }
      result.push({
        order: i + 1,
        tool_id: entry.metadata?.tool_id ?? rs.tool_id,
        title: entry.name ?? rs.tool_id,
        url,
        prefilled: prefill && !!(rs.fields && Object.keys(rs.fields).length > 0),
        prefill_enabled: prefill,
        handoff_note,
      });
    }

    const output = {
      chain: chain ?? null,
      chain_title: chainMeta?.title ?? null,
      chain_description: chainMeta?.description ?? null,
      composer_url: chainMeta?.composer_url ?? null,
      step_count: result.length,
      steps: result,
      warnings,
      note: 'All tool logic executes in the user\'s browser -- zero server-side execution. Open each URL in order; export a Policy Mandate at each stage before proceeding.',
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
      structuredContent: output,
    };
  });

  return server;
}

// Origin allowlist (MCP streamable-HTTP spec: servers MUST validate Origin -- anti-DNS-rebinding).
// Server-to-server clients (Claude's backend) send no Origin and pass; browser requests from
// unlisted origins get 403. Extend the list if a legitimate browser-based MCP host needs access.
const ALLOWED_ORIGINS = new Set([
  'https://claude.ai',
  'https://claude.com',
  'https://mcp.ainumbers.co',
  'https://ainumbers.co',
]);

export default {
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);

    const origin = request.headers.get('Origin');
    if (origin && !ALLOWED_ORIGINS.has(origin)) {
      return Response.json({ error: 'forbidden origin' }, { status: 403 });
    }

    if (url.pathname === '/healthz') {
      return Response.json({ ok: true, widgets: PILOT.length, runtime: 'cloudflare-workers' });
    }
    // Glama directory ownership claim -- email must match the maintainer's Glama account.
    // Glama polls this path on the connector's server domain and auto-verifies within minutes.
    if (url.pathname === '/.well-known/glama.json') {
      return Response.json({
        $schema: 'https://glama.ai/mcp/schemas/connector.json',
        maintainers: [{ email: 'tim@postoaklabs.com' }],
      });
    }
    // Favicon + minimal root page so favicon crawlers (and humans) get something sensible.
    if (url.pathname === '/favicon.ico' || url.pathname === '/favicon.png') {
      const r = await env.ASSETS.fetch('https://assets.local/favicon.png');
      return new Response(r.body, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
    }
    if (url.pathname === '/') {
      return new Response('<!DOCTYPE html><html><head><title>AINumbers MCP</title><link rel="icon" type="image/png" href="/favicon.png"></head>' +
        '<body><p>AINumbers Fintech Intelligence Suite -- MCP server. Endpoint: <code>/mcp</code> (streamable HTTP, no auth). ' +
        'Docs: <a href="https://ainumbers.co/mcp.html">ainumbers.co/mcp.html</a></p></body></html>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    if (url.pathname !== '/mcp') {
      return new Response('Not found', { status: 404 });
    }

    try {
      const data = await loadData(env);
      const server = buildServer(data);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);

      const body = request.method === 'POST' ? await request.clone().json() : undefined;
      const { req, res } = toReqRes(request);
      // fetch() strips the Host header; the MCP SDK needs it to reconstruct the request URL.
      req.headers.host = url.host;
      res.on('close', () => { transport.close(); server.close(); });
      await transport.handleRequest(req, res, body);
      return await toFetchResponse(res);
    } catch (e) {
      return Response.json(
        { jsonrpc: '2.0', error: { code: -32603, message: String(e) }, id: null },
        { status: 500 },
      );
    }
  },
};
