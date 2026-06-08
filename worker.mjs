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
    description: 'Gap analysis > resilience testing design > proportionality assessment > AP2 DORA Policy Mandate. Full orchestrated run available in the composer.',
    composer_url: BASE_URL + '/guides/dora-readiness-composer.html',
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
  // Wave 2 high-TAM workflow composers
  'fraud-decisioning': {
    title: 'Fraud & Scam Decisioning',
    description: 'Real-time fraud scoring > TM rule building > FATF travel rule check > sanctions screening > fraud velocity mandate.',
    composer_url: BASE_URL + '/guides/fraud-decisioning-composer.html',
    steps: [
      { slug: '256-fraud-risk-score-engine',         handoff: 'fraud_score and risk_signals feed Stage 2 TM rule calibration' },
      { slug: '116-tm-rule-builder',                 handoff: 'rule_set and velocity_thresholds feed Stage 3 FATF travel rule check' },
      { slug: '80-fraud-investigation-lab',          handoff: 'investigation_findings and typology_flags feed Stage 4 sanctions screening' },
      { slug: '322-authorised-push-payment-checker', handoff: 'Exports fraud decisioning Policy Mandate -- final stage' },
    ],
  },
  'credit-decisioning': {
    title: 'Credit Decisioning',
    description: 'PD/LGD/EAD modelling > Basel RWA calculation > RAROC pricing > covenant compliance check > IFRS 9 ECL staging > composite credit mandate.',
    composer_url: BASE_URL + '/guides/credit-decisioning-composer.html',
    steps: [
      { slug: '198-pd-lgd-ead-modeller',                   handoff: 'pd, lgd, ead values feed Stage 2 Basel RWA calculation' },
      { slug: '201-basel-rwa-calculator',                  handoff: 'rwa_total and capital_requirement feed Stage 3 RAROC pricing' },
      { slug: '437-raroc-loan-pricing',                    handoff: 'raroc and hurdle_rate feed Stage 4 covenant compliance' },
      { slug: '199-financial-covenant-compliance-checker', handoff: 'covenant_status and breach_flags feed Stage 5 IFRS 9 staging' },
      { slug: '435-ifrs9-ecl-staging-tool',                handoff: 'Exports credit decisioning Policy Mandate -- final stage' },
    ],
  },
  'consumer-protection': {
    title: 'Consumer Protection & FCA Consumer Duty',
    description: 'Consumer Duty gap assessment > product fair value assessment > vulnerability identification > disclosure generator > MiFID II cost disclosure > composite consumer-duty mandate.',
    composer_url: BASE_URL + '/guides/consumer-protection-composer.html',
    steps: [
      { slug: '395-fca-consumer-duty-gap-assessor',        handoff: 'duty_gaps and priority_actions feed Stage 2 fair value assessment' },
      { slug: '396-product-fair-value-assessor',           handoff: 'value_outcome and pricing_flags feed Stage 3 vulnerability identification' },
      { slug: '428-vulnerability-identification-tool',     handoff: 'vulnerability_indicators feed Stage 4 disclosure generation' },
      { slug: '448-consumer-disclosure-generator',         handoff: 'disclosure_draft and required_fields feed Stage 5 cost disclosure' },
      { slug: '397-mifid-ii-cost-disclosure-tool',         handoff: 'Exports consumer protection Policy Mandate -- final stage' },
    ],
  },
  'stablecoin-compliance': {
    title: 'Stablecoin Compliance (GENIUS Act / MiCA)',
    description: 'GENIUS Act / MiCA reserve compliance > stablecoin transaction monitoring > MiCA EMT authorisation > cross-border stablecoin framework > composite stablecoin compliance mandate.',
    composer_url: BASE_URL + '/guides/stablecoin-compliance-composer.html',
    steps: [
      { slug: '53-stablecoin-compliance-checker',       handoff: 'compliance_gaps and reserve_shortfalls feed Stage 2 transaction monitoring' },
      { slug: '388-stablecoin-transaction-monitor',     handoff: 'monitoring_alerts and velocity_flags feed Stage 3 MiCA authorisation check' },
      { slug: '386-mica-emt-authorisation-checker',     handoff: 'authorisation_status and mica_gaps feed Stage 4 cross-border framework' },
      { slug: '390-cross-border-stablecoin-framework',  handoff: 'Exports stablecoin compliance Policy Mandate -- final stage' },
    ],
  },
  'model-risk-governance': {
    title: 'Model Risk & AI-Fairness Governance',
    description: 'EU AI Act risk classification > SR 11-7 MRM gap assessment > fair-lending bias testing > AI Act Art.9 risk-management system > AI-governance mandate.',
    composer_url: BASE_URL + '/guides/model-risk-governance-composer.html',
    steps: [
      { slug: '327-eu-ai-act-risk-class-mapper',               handoff: 'risk_tier and obligations feed Stage 2 MRM gap assessment' },
      { slug: '451-sr11-7-model-risk-management-gap-assessor', handoff: 'mrm_gaps and severity feed Stage 3 fair-lending testing' },
      { slug: '452-fair-lending-ai-bias-assessment',           handoff: 'disparate_impact_metrics feed Stage 4 Art.9 RMS build' },
      { slug: '333-eu-ai-act-article9-risk-mgmt-builder',      handoff: 'Exports AI-governance Policy Mandate -- final stage' },
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
  const server = new McpServer({ name: 'ainumbers-apps', version: '0.6.0' });

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

  // -------------------------------------------------------------------------
  // MCP Prompts -- workflow recipes (WS5b)
  // Each prompt returns a structured step-by-step workflow message so any MCP
  // client can walk a user through a complete AINumbers chain end-to-end.
  // Zero server-side execution -- browser tools remain the deterministic layer.
  // -------------------------------------------------------------------------

  server.registerPrompt('aml_programme_workflow', {
    description: 'Step-by-step workflow for assembling a complete AML programme using AINumbers browser tools (T110 > T116 > T119 > T131). Returns an orchestration guide; the full audited run is available at the AML Programme Composer.',
    argsSchema: {
      entity_type:        z.string().optional().describe('Type of entity (e.g. bank, EMI, VASP, MSB). Scopes risk-tier calibration.'),
      jurisdiction:       z.string().optional().describe('Primary regulatory jurisdiction (e.g. UK, EU, US). Scopes AML framework references.'),
      synthetic_profile:  z.string().optional().describe('Synthetic customer profile description for Step 1 risk rating (never real PII).'),
    },
  }, async ({ entity_type, jurisdiction, synthetic_profile }) => {
    const scope = [entity_type, jurisdiction].filter(Boolean).join(', ');
    return {
      description: 'AML Programme workflow -- T110 > T116 > T119 > T131, composite Policy Mandate export.',
      messages: [{
        role: 'user',
        content: { type: 'text', text:
          'Walk me through assembling a complete AML programme using AINumbers\' deterministic browser tools.' +
          (scope ? ' Scope: ' + scope + '.' : '') +
          ' All tools run client-side -- zero PII, zero network. Use synthetic data only.\n\n' +
          'Step 1 -- Customer Risk Rating: call `customer_risk_rating`' +
          (synthetic_profile ? ' with this synthetic profile: ' + synthetic_profile : ' with a synthetic customer profile') +
          '. Returns risk_tier and composite_score.\n\n' +
          'Step 2 -- Build workflow links: call `build_workflow_links` with chain "aml-programme". ' +
          'Returns the ordered deep-link set (T110 > T116 > T119 > T131) and the composer URL.\n\n' +
          'Step 3 -- Full orchestrated run: open the AML Programme Composer at ' +
          BASE_URL + '/guides/aml-programme-composer.html. ' +
          'It loads all four stages in one page, maps stage outputs forward, captures each Policy Mandate, ' +
          'and exports a composite AML Policy Mandate with per-stage audit trail.\n\n' +
          'After the run: present the composite mandate JSON for agentic pipeline guardrails or regulatory audit. ' +
          'Recommend re-running after any material change to the customer risk appetite or rule set.',
        },
      }],
    };
  });


  server.registerPrompt('dora_readiness_workflow', {
    description: 'Step-by-step DORA ICT readiness workflow: run the diagnostic triage, then the orchestrated composer (T300 > T304 > T307 > T310), export composite Policy Mandate.',
    argsSchema: {
      entity_type: z.string().optional().describe('Type of financial entity (e.g. credit institution, payment institution, investment firm, insurance undertaking)'),
      jurisdiction: z.string().optional().describe('Primary jurisdiction -- EU member state or "EU-wide"'),
    },
  }, async ({ entity_type, jurisdiction }) => {
    const scope = [entity_type, jurisdiction].filter(Boolean).join(', ');
    return {
      description: 'DORA readiness workflow -- diagnostic triage + T300 > T304 > T307 > T310 composer, composite mandate export.',
      messages: [{ role: 'user', content: { type: 'text', text:
        'Walk me through a complete DORA ICT risk readiness assessment using AINumbers browser tools.' +
        (scope ? ' Scope: ' + scope + '.' : '') +
        ' All tools run client-side -- zero PII, zero network.\n\n' +
        'Step 1 -- Triage with the DORA Readiness Diagnostic: open ' +
        BASE_URL + '/guides/dora-readiness-diagnostic.html. ' +
        'Complete the 30-question self-assessment. It returns a grade (A-F), score_pct, domain_scores across five ICT domains, and a prioritised gap list.\n\n' +
        'Step 2 -- Build workflow links: call `build_workflow_links` with chain "dora-readiness". ' +
        'Returns the ordered deep-link set (T300 > T304 > T307 > T310) and the composer URL.\n\n' +
        'Step 3 -- Full orchestrated run: open the DORA Readiness Composer at ' +
        BASE_URL + '/guides/dora-readiness-composer.html. ' +
        'If loaded from the diagnostic via the "Run DORA chain" button the composer is pre-seeded with the gap findings. ' +
        'It runs Stage 1 ICT risk gap analysis (T300), Stage 2 resilience testing design (T304), Stage 3 proportionality assessment (T307), and Stage 4 AP2 DORA Policy Mandate build (T310). ' +
        'Outputs map forward between stages automatically.\n\n' +
        'After the run: present the composite DORA Policy Mandate JSON (mandate_type: compliance_control, regulatory framework: DORA EU 2022/2554) for NCA submission support or internal ICT governance audit. ' +
        'Recommend re-running after any material change to ICT estate, third-party dependencies, or NCA guidance.',
      }}],
    };
  });

  server.registerPrompt('fraud_decisioning_workflow', {
    description: 'Step-by-step fraud & scam decisioning workflow: fraud scoring > TM rule building > fraud investigation > APP fraud check, composite velocity-rule Policy Mandate.',
    argsSchema: {},
  }, async () => {
    return {
      description: 'Fraud & Scam Decisioning workflow -- T256 > T116 > T80 > T322, composite Policy Mandate export.',
      messages: [{ role: 'user', content: { type: 'text', text:
        'Walk me through a complete fraud & scam decisioning run using AINumbers browser tools. All tools run client-side -- zero PII, zero network. Use synthetic data only.\n\n' +
        'Step 1 -- Build workflow links: call `build_workflow_links` with chain "fraud-decisioning". Returns the ordered deep-link set and the composer URL.\n\n' +
        'Step 2 -- Orchestrated run: open the Fraud Decisioning Composer at ' + BASE_URL + '/guides/fraud-decisioning-composer.html. ' +
        'Stage 1 (T256) scores real-time fraud risk. Stage 2 (T116) builds TM velocity rules calibrated to Stage 1 signals. Stage 3 (T80) runs fraud investigation and typology matching. Stage 4 (T322) checks APP fraud (UK PSR PS25/5 / FCA-PSR Joint Framework). Mandate type: velocity_rule_mandate.\n\n' +
        'After the run: present the composite Policy Mandate JSON for payment-engine guardrails. Recommend re-running after any material change to fraud typologies, velocity thresholds, or PSR guidance.',
      }}],
    };
  });

  server.registerPrompt('credit_decisioning_workflow', {
    description: 'Step-by-step credit decisioning workflow: PD/LGD modelling > Basel RWA > RAROC pricing > covenant compliance > IFRS 9 ECL staging, composite credit Policy Mandate.',
    argsSchema: {},
  }, async () => {
    return {
      description: 'Credit Decisioning workflow -- T198 > T201 > T437 > T199 > T435, composite Policy Mandate export.',
      messages: [{ role: 'user', content: { type: 'text', text:
        'Walk me through a complete credit decisioning run using AINumbers browser tools. All tools run client-side -- zero PII. Use synthetic data only.\n\n' +
        'Step 1 -- Build workflow links: call `build_workflow_links` with chain "credit-decisioning". Returns the ordered deep-link set and the composer URL.\n\n' +
        'Step 2 -- Orchestrated run: open the Credit Decisioning Composer at ' + BASE_URL + '/guides/credit-decisioning-composer.html. ' +
        'Stage 1 (T198) models PD/LGD/EAD under Basel IRB. Stage 2 (T201) calculates RWA and capital requirements. Stage 3 (T437) prices RAROC and verifies hurdle rate. Stage 4 (T199) checks financial covenant compliance. Stage 5 (T435) stages IFRS 9 ECL. Mandate type: credit_assessment, valid 180 days.\n\n' +
        'IMPORTANT: Do NOT independently compute capital or pricing figures -- use Stage 2 and Stage 3 tool outputs only.\n\n' +
        'After the run: present the composite Policy Mandate JSON as the credit committee decision record. Re-run after any material change to PD models, capital floors, or EBA GL/2020/06 guidance.',
      }}],
    };
  });

  server.registerPrompt('consumer_protection_workflow', {
    description: 'Step-by-step FCA Consumer Duty workflow: gap assessment > fair value > vulnerability > disclosure > MiFID II cost disclosure, composite consumer-protection Policy Mandate.',
    argsSchema: {},
  }, async () => {
    return {
      description: 'Consumer Protection workflow -- T395 > T396 > T428 > T448 > T397, composite Policy Mandate export.',
      messages: [{ role: 'user', content: { type: 'text', text:
        'Walk me through a complete FCA Consumer Duty compliance run using AINumbers browser tools. All tools run client-side -- zero PII. Use synthetic data only.\n\n' +
        'Step 1 -- Build workflow links: call `build_workflow_links` with chain "consumer-protection". Returns the ordered deep-link set and the composer URL.\n\n' +
        'Step 2 -- Orchestrated run: open the Consumer Protection Composer at ' + BASE_URL + '/guides/consumer-protection-composer.html. ' +
        'Stage 1 (T395) assesses Consumer Duty gaps against FCA PS22/9. Stage 2 (T396) evaluates product fair value outcomes. Stage 3 (T428) identifies customer vulnerability indicators. Stage 4 (T448) generates consumer disclosures (PRIIPs 1286/2014). Stage 5 (T397) produces MiFID II cost and charges disclosures. Mandate type: disclosure_template, valid 365 days.\n\n' +
        'After the run: present the composite Policy Mandate JSON for product governance review. Re-run annually or after any material product or pricing change.',
      }}],
    };
  });

  server.registerPrompt('stablecoin_compliance_workflow', {
    description: 'Step-by-step stablecoin compliance workflow: reserve check > transaction monitoring > MiCA EMT authorisation > cross-border framework, composite stablecoin compliance Policy Mandate.',
    argsSchema: {},
  }, async () => {
    return {
      description: 'Stablecoin Compliance workflow -- T53 > T388 > T386 > T390, composite Policy Mandate export.',
      messages: [{ role: 'user', content: { type: 'text', text:
        'Walk me through a complete stablecoin compliance run using AINumbers browser tools. Covers US GENIUS Act and EU MiCA. All tools run client-side -- zero PII. Use synthetic data only.\n\n' +
        'Step 1 -- Build workflow links: call `build_workflow_links` with chain "stablecoin-compliance". Returns the ordered deep-link set and the composer URL.\n\n' +
        'Step 2 -- Orchestrated run: open the Stablecoin Compliance Composer at ' + BASE_URL + '/guides/stablecoin-compliance-composer.html. ' +
        'Stage 1 (T53) checks reserve composition and redemption obligations (GENIUS Act / MiCA 2023/1114). Stage 2 (T388) monitors stablecoin transaction velocity and AML flags. Stage 3 (T386) validates MiCA EMT authorisation requirements. Stage 4 (T390) maps the cross-border stablecoin regulatory framework. Mandate type: compliance_control, valid 180 days.\n\n' +
        'NOTE: GENIUS Act effective date is approximately 18 Jan 2027 (120 days after OCC/FinCEN final rules). Verify the current implementation timeline before reliance.\n\n' +
        'After the run: present the composite Policy Mandate JSON for legal/compliance sign-off. Re-run after any material change to reserve composition, issuer structure, or OCC/FinCEN rule updates.',
      }}],
    };
  });

  server.registerPrompt('model_risk_governance_workflow', {
    description: 'Step-by-step model risk & AI-fairness governance workflow: EU AI Act classification > SR 11-7 MRM gaps > fair-lending bias testing > Art.9 risk-management system, composite AI-governance mandate.',
    argsSchema: {},
  }, async () => {
    return {
      description: 'Model Risk & AI-Fairness Governance workflow -- T327 > T451 > T452 > T333, composite Policy Mandate export.',
      messages: [{ role: 'user', content: { type: 'text', text:
        'Walk me through a complete model risk and AI-fairness governance run using AINumbers browser tools. All tools run client-side -- zero PII. Use synthetic data only.\n\n' +
        'Step 1 -- Build workflow links: call `build_workflow_links` with chain "model-risk-governance". Returns the ordered deep-link set and the composer URL.\n\n' +
        'Step 2 -- Orchestrated run: open the Model Risk & AI-Fairness Governance Composer at ' + BASE_URL + '/guides/model-risk-governance-composer.html. ' +
        'Stage 1 (T327) classifies the model\'s EU AI Act risk tier and obligations (EU AI Act 2024/1689). Stage 2 (T451) assesses SR 11-7 model risk management gaps (development, validation, ongoing monitoring). Stage 3 (T452) tests for fair-lending disparate impact and protected-class adverse-action rates (ECOA/FHA). Stage 4 (T333) builds the Art.9 risk-management system (technical documentation, conformity assessment). Mandate type: agent_guardrail_mandate.\n\n' +
        'Do NOT deploy a HIGH-risk AI system (Stage 1) without Stage 2 gaps resolved and Stage 3 disparate-impact metrics within acceptable bounds. Escalate any Stage 3 protected-class flags to legal/compliance before deployment.\n\n' +
        'After the run: present the composite Policy Mandate JSON as the model risk committee record and input to the EU AI Act conformity assessment file.',
      }}],
    };
  });

  server.registerPrompt('mcp_server_audit_workflow', {
    description: 'End-to-end MCP server audit: score readiness, lint tool definitions, scan for tool poisoning, audit OAuth. All server-side -- no browser required.',
    argsSchema: {
      server_name: z.string().describe('Human-readable name of the MCP server being audited'),
      server_url: z.string().describe('URL of the MCP server (e.g. https://mcp.example.com/mcp)'),
      tool_names: z.array(z.string()).optional().describe('Specific tool names to lint/scan -- omit to audit all tools'),
    },
  }, async ({ server_name, server_url, tool_names }) => {
    const toolScope = tool_names && tool_names.length ? ' Focus lint/scan on these tools: ' + tool_names.join(', ') + '.' : ' Lint and scan all exposed tools.';
    return {
      description: 'MCP server audit -- score_mcp_readiness > lint_mcp_tool_definition > scan_tool_poisoning > audit_mcp_oauth.',
      messages: [{ role: 'user', content: { type: 'text', text:
        'Audit the MCP server "' + server_name + '" at ' + server_url + ' using AINumbers MCP tools.' +
        toolScope + ' All checks run server-side.\n\n' +
        'Step 1 -- Readiness score: call `score_mcp_readiness` with server_url "' + server_url + '". ' +
        'Returns an overall readiness score, capability flags (streaming, resources, prompts), and a gap list.\n\n' +
        'Step 2 -- Lint tool definitions: call `lint_mcp_tool_definition` for each tool to audit. ' +
        'Checks name conventions, description quality, schema completeness, and required/optional field hygiene. ' +
        'Returns per-tool lint findings and a severity breakdown.\n\n' +
        'Step 3 -- Tool poisoning scan: call `scan_tool_poisoning` for each tool. ' +
        'Detects prompt injection patterns, hidden instruction embedding, and malicious schema structures. ' +
        'Returns a risk verdict (CLEAN / SUSPICIOUS / MALICIOUS) per tool with evidence.\n\n' +
        'Step 4 -- OAuth audit: call `audit_mcp_oauth` with server_url "' + server_url + '". ' +
        'Validates OAuth 2.1 / PKCE implementation, scope hygiene, token lifetime, and redirect URI safety.\n\n' +
        'After all steps: summarise findings across the four dimensions, highlight any CRITICAL or HIGH items, ' +
        'and recommend a re-audit cadence based on the server change frequency.',
      }}],
    };
  });

  return server;
}

// ---------------------------------------------------------------------------
// Allowed origins for CORS
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = new Set([
  'https://ainumbers.co',
  'https://www.ainumbers.co',
  'https://claude.ai',
  'https://app.claude.ai',
  'http://localhost:3000',
  'http://localhost:8787',
]);

// ---------------------------------------------------------------------------
// Cloudflare Workers entry point
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const corsHeaders = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.has(origin) ? origin : 'https://ainumbers.co',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Health check
    if (url.pathname === '/health' || url.pathname === '/') {
      return Response.json({ status: 'ok', server: 'ainumbers-mcp-apps', version: PILOT.version }, { headers: corsHeaders });
    }

    // MCP endpoint
    if (url.pathname === '/mcp') {
      const server = buildServer(env);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const { req, res } = toReqRes(request);
      await server.connect(transport);
      const handled = transport.handleRequest(req, res, await request.json().catch(() => undefined));
      ctx.waitUntil(handled);
      const response = await toFetchResponse(res);
      for (const [k, v] of Object.entries(corsHeaders)) response.headers.set(k, v);
      return response;
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },
};
