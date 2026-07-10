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
import { getKernel } from './kernels/index.mjs';
import { evaluateGate as gvEvaluateGate, stepId as gvStepId, isEscalationTarget, isTerminalTarget } from './kernels/_gateval.mjs';
import { verifyProofs, didKeyToPublicKey } from './embed/lib/_proof.mjs';
import { registerExportArtifact } from './exporters/index.mjs';
import { UTILITY_TOOL_NAMES } from './utility-tools.mjs';
import { cgCanon as sharedCgCanon } from './kernels/_hash.mjs';
import { verifyRfc3161, extractMessageImprintHex, FREETSA_ROOT_PEM } from './kernels/_rfc3161.mjs';
import { compute as c2paCompute } from './kernels/art-123-c2pa-manifest-validator.kernel.mjs';
import { dueForRenewal, verifyAllBindings } from './_blta.mjs';
import { runReserveWatchCheck, SAMPLE_RESERVE_REPORT } from './_reserve_watch.mjs';
import { runAiActEvidenceExport, SAMPLE_DECISION } from './_aiact_cron.mjs';
import { authzenEvaluateWithReceipt } from './_authzen.mjs';
// GAP-a (2026-07-10): re-export the durable Workflow class so wrangler.jsonc's `workflows`
// binding (class_name: "RenewalWatchWorkflow") can find it on the main script, per CF Workflows'
// requirement that the bound class be exported from the entrypoint module.
export { RenewalWatchWorkflow } from './workflows/renewal-watch-workflow.mjs';

const BASE_URL = 'https://ainumbers.co';

// ---------------------------------------------------------------------------
// NAMED_CHAINS: Workstream F MIGRATION IN PROGRESS.
// The canonical source of truth is now chaingraph.json → "chains" array.
// build_workflow_links reads from namedChains (built from chaingraph.chains inside
// buildServer). NAMED_CHAINS retained here for reference; scheduled for removal
// after the next deploy confirms the canonical source is stable.
// Steps in chaingraph.chains use tool_id (not slug).
// ---------------------------------------------------------------------------
const NAMED_CHAINS = {
  // Live composers
  'aml-programme': {
    title: 'AML Programme',
    description: 'Customer risk rating > TM rule building > CTR/SAR thresholds > AML Policy Mandate. Full audited run available in the composer.',
    composer_url: BASE_URL + '/chaingraph/chains/aml-consolidation.html',
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
    composer_url: BASE_URL + '/chaingraph/chains/cbpr-cutover.html',
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
    composer_url: BASE_URL + '/chaingraph/chains/rtp-participation.html',
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
    composer_url: BASE_URL + '/chaingraph/chains/sca-consent-fapi.html',
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
    composer_url: BASE_URL + '/chaingraph/chains/dora-readiness.html',
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
    composer_url: BASE_URL + '/chaingraph/chains/transaction-screening.html',
    steps: [
      { slug: '43-batch-sanctions-screening', handoff: 'screening_results and hit_list feed T222 travel rule check' },
      { slug: '222-fatf-travel-rule-checker', handoff: 'travel_rule_status and originator_flags feed T80 fraud investigation' },
      { slug: '80-fraud-investigation-lab',   handoff: 'Exports transaction screening Policy Mandate -- final stage' },
    ],
  },
  'regulatory-impact': {
    title: 'Regulatory Impact to Policy Mandate',
    description: 'Regulatory change impact assessment > NIS2/DORA overlap mapping > AP2 DORA Policy Mandate.',
    composer_url: BASE_URL + '/chaingraph/chains/regulatory-impact.html',
    steps: [
      { slug: '318-regulatory-change-impact-assessor', handoff: 'impact_domains and change_timeline feed T309 NIS2/DORA overlap map' },
      { slug: '309-nis2-dora-overlap-mapper',          handoff: 'overlap_matrix and dual_obligations feed T310 policy mandate build' },
      { slug: '310-ap2-dora-policy-mandate-builder',   handoff: 'Exports regulatory impact Policy Mandate -- final stage' },
    ],
  },
  'fx-corridor': {
    title: 'Corridor Cost and Failure Analysis',
    description: 'FX margin transparency > cross-border failure modelling > corridor cost ranking > payment corridor optimisation.',
    composer_url: BASE_URL + '/chaingraph/chains/fx-corridor.html',
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
    composer_url: BASE_URL + '/chaingraph/chains/pd-lgd-covenant.html',
    steps: [
      { slug: '198-pd-lgd-ead-modeller',                   handoff: 'pd, lgd, ead values feed T201 Basel RWA calculation' },
      { slug: '201-basel-rwa-calculator',                  handoff: 'rwa_total and capital_requirement feed T199 covenant compliance' },
      { slug: '199-financial-covenant-compliance-checker', handoff: 'Exports credit risk Policy Mandate -- final stage' },
    ],
  },
  'stablecoin-reserve': {
    title: 'GENIUS Act / MiCA Reserve Compliance',
    description: 'Reserve portfolio optimisation > smart contract validation > RWA tokenisation cost modelling.',
    composer_url: BASE_URL + '/chaingraph/chains/stablecoin-reserve.html',
    steps: [
      { slug: '328-genius-act-reserve-optimizer', handoff: 'reserve_composition and compliance_status feed T54 smart contract validation' },
      { slug: '54-smart-contract-validator',      handoff: 'contract_audit and risk_flags feed T66 RWA tokenisation cost model' },
      { slug: '66-rwa-tokenization-cost-model',   handoff: 'Exports stablecoin reserve Policy Mandate -- final stage' },
    ],
  },
  'baas-programme': {
    title: 'BaaS Provider Selection to Compliance Mapping',
    description: 'BaaS provider scoring > embedded lending unit economics > compliance control mapping > B2B fraud detection.',
    composer_url: BASE_URL + '/chaingraph/chains/baas-programme.html',
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
    composer_url: BASE_URL + '/chaingraph/chains/card-interchange.html',
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
    description: 'Velocity rule building > structuring pattern detection > fraud investigation > APP-scam risk scoring > fraud/velocity policy mandate.',
    composer_url: BASE_URL + '/chaingraph/chains/fraud-decisioning.html',
    steps: [
      { slug: '256-rtp-fraud-velocity-rule-builder', handoff: 'rule_set and velocity_thresholds feed Stage 2 structuring pattern detection' },
      { slug: '117-structuring-pattern-detector',    handoff: 'detected_patterns and risk_flags feed Stage 3 fraud investigation' },
      { slug: '80-fraud-investigation-lab',          handoff: 'investigation_findings and disposition feed Stage 4 APP-scam scoring' },
      { slug: '322-app-scam-risk-assessor',          handoff: 'Exports fraud/velocity Policy Mandate -- final stage' },
    ],
  },
  'credit-decisioning': {
    title: 'Credit Decisioning',
    description: 'PD/LGD/EAD modelling > Basel RWA calculation > RAROC pricing > covenant compliance check > facility structuring > composite credit mandate.',
    composer_url: BASE_URL + '/chaingraph/chains/credit-decisioning.html',
    steps: [
      { slug: '198-pd-lgd-ead-modeller',                   handoff: 'pd, lgd, ead values feed Stage 2 Basel RWA calculation' },
      { slug: '201-basel-rwa-calculator',                  handoff: 'rwa_total and capital_requirement feed Stage 3 RAROC pricing' },
      { slug: '437-raroc-loan-pricing',                    handoff: 'raroc and hurdle_rate feed Stage 4 covenant compliance' },
      { slug: '199-financial-covenant-compliance-checker', handoff: 'covenant_status and breach_flags feed Stage 5 facility structuring' },
      { slug: '435-credit-facility-structuring',           handoff: 'Exports credit decisioning Policy Mandate -- final stage' },
    ],
  },
  'consumer-protection': {
    title: 'Consumer Protection & FCA Consumer Duty',
    description: 'Vulnerability assessment > fair-value assessment > MiFID costs & charges > PRIIPs KID compliance > Consumer Duty board MI > composite consumer-duty mandate.',
    composer_url: BASE_URL + '/guides/consumer-protection-composer.html',
    steps: [
      { slug: '395-consumer-duty-vulnerability-assessment-builder', handoff: 'vulnerability_segments feed Stage 2 fair-value assessment' },
      { slug: '396-consumer-duty-price-value-assessment',           handoff: 'value_rating and outlier_flags feed Stage 3 costs aggregation' },
      { slug: '428-mifid-costs-charges-calculator',                 handoff: 'total_cost_ratio and cost_breakdown feed Stage 4 KID check' },
      { slug: '448-priips-kid-compliance-checker',                  handoff: 'kid_compliance_status feeds Stage 5 board MI framework' },
      { slug: '397-consumer-duty-mi-framework-builder',             handoff: 'Exports consumer protection Policy Mandate -- final stage' },
    ],
  },
  'stablecoin-compliance': {
    title: 'Stablecoin Compliance (GENIUS Act / MiCA)',
    description: 'Issuance architecture > reserve stress testing > GENIUS Act compliance > MiCA white paper / CASP > composite stablecoin compliance mandate.',
    composer_url: BASE_URL + '/chaingraph/chains/stablecoin-compliance.html',
    steps: [
      { slug: '53-cbdc-architecture-comparator',                      handoff: 'architecture_choice feeds Stage 2 reserve stress testing' },
      { slug: '388-stablecoin-reserve-stress-test-modeller',          handoff: 'reserve_adequacy and stress_results feed Stage 3 GENIUS Act check' },
      { slug: '386-genius-act-payment-stablecoin-compliance-checker', handoff: 'genius_compliance_status feeds Stage 4 MiCA white paper' },
      { slug: '390-mica-white-paper-builder',                         handoff: 'Exports stablecoin compliance Policy Mandate -- final stage' },
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
  // Wave 3 high-TAM workflow composers
  'instant-payments-vop': {
    title: 'Instant Payments & Verification of Payee Readiness',
    description: 'Rail participation readiness > Verification of Payee simulation > intraday liquidity sizing > IPR annual report > instant-payments policy mandate. EU Instant Payments Regulation (VoP mandatory since Oct 2025). Full audited run in the composer.',
    composer_url: BASE_URL + '/chaingraph/chains/instant-payments-vop.html',
    steps: [
      { slug: '229-rtp-network-participation-checker',   handoff: 'participation_gaps feed Stage 2 VoP simulation' },
      { slug: '289-verification-of-payee-simulator',     handoff: 'vop_match_rates and response_timing feed Stage 3 liquidity sizing' },
      { slug: '258-intraday-credit-facility-sizer',      handoff: 'intraday_facility_size feeds Stage 4 IPR report' },
      { slug: '349-sepa-ipr-annual-report-builder',      handoff: 'ipr_report_data feeds Stage 5 RTP policy mandate' },
      { slug: '259-ap2-rtp-policy-builder',              handoff: 'Exports instant-payments Policy Mandate -- final stage' },
    ],
  },
  'baas-sponsor-bank': {
    title: 'BaaS / Sponsor-Bank Oversight & Readiness',
    description: 'Provider selection > FBO account structure > ledger architecture > BSA/AML control mapping > sponsor-bank readiness score. Post-Synapse third-party oversight; full audited run in the composer.',
    composer_url: BASE_URL + '/guides/baas-sponsor-bank-composer.html',
    steps: [
      { slug: '152-baas-provider-comparator',           handoff: 'provider_shortlist feeds Stage 2 FBO structuring' },
      { slug: '153-fbo-account-structure-simulator',    handoff: 'fbo_structure and reconciliation_model feed Stage 3 ledger design' },
      { slug: '154-ledger-architecture-builder',        handoff: 'ledger_topology feeds Stage 4 control mapping' },
      { slug: '158-fintech-compliance-control-mapper',  handoff: 'control_gaps feed Stage 5 readiness scoring' },
      { slug: '162-sponsor-bank-readiness-scorer',      handoff: 'Exports BaaS programme Policy Mandate -- final stage' },
    ],
  },
  'einvoicing-vida': {
    title: 'E-Invoicing & ViDA Digital Reporting',
    description: 'DRR readiness > B2B e-invoice compliance (EN16931) > Peppol XML audit > invoice-to-ISO20022 bridge > e-invoicing compliance mandate. EU ViDA phased mandates 2026-2030.',
    composer_url: BASE_URL + '/chaingraph/chains/einvoicing-vida.html',
    steps: [
      { slug: '179-vida-drr-readiness-scorer',      handoff: 'drr_gaps feed Stage 2 e-invoice compliance scoring' },
      { slug: '180-b2b-einvoice-compliance-scorer', handoff: 'compliance_score and field_errors feed Stage 3 XML audit' },
      { slug: '174-peppol-xml-auditor',             handoff: 'xml_validation_results feed Stage 4 ISO 20022 bridge' },
      { slug: '178-invoice-to-iso20022-bridge',     handoff: 'Exports e-invoicing Policy Mandate -- final stage' },
    ],
  },
  'us-banking-compliance': {
    title: 'US Consumer-Banking Compliance',
    description: 'HMDA reportability > BSA/SAR filing adequacy > Reg E dispute timelines > Durbin interchange analysis > consumer-banking compliance mandate.',
    composer_url: BASE_URL + '/guides/us-banking-compliance-composer.html',
    steps: [
      { slug: '444-hmda-reportability-checker',            handoff: 'reportable_loans and data_gaps feed Stage 2 BSA/SAR check' },
      { slug: '445-bsa-sar-filing-adequacy-checker',       handoff: 'sar_adequacy_flags feed Stage 3 Reg E workflow' },
      { slug: '442-reg-e-dispute-workflow-builder',        handoff: 'dispute_timelines feed Stage 4 Durbin analysis' },
      { slug: '443-durbin-amendment-interchange-analyzer', handoff: 'Exports consumer-banking compliance Policy Mandate -- final stage' },
    ],
  },

  // Wave 4 composers
  'wealth-advisory-regbi': {
    title: 'US Wealth & Advisory — Reg BI Suitability',
    description: 'Model portfolio risk > Reg BI best-interest check (T463 NEW) > portfolio construction/rebalancing > costs & fee disclosure > Form CRS (T464 NEW). SEC Reg BI 2026 FINRA enforcement priority.',
    composer_url: BASE_URL + '/guides/wealth-advisory-regbi-composer.html',
    steps: [
      { slug: '429-model-portfolio-risk-analytics',       handoff: 'risk_profile and model_allocation feed Stage 2 Reg BI best-interest check' },
      { slug: '463-reg-bi-best-interest-checker',         handoff: 'reg_bi_verdict and obligation_gaps feed Stage 3 portfolio construction' },
      { slug: '432-portfolio-drift-rebalancing',          handoff: 'rebalancing_trades and cost_estimates feed Stage 4 costs disclosure' },
      { slug: '428-mifid-costs-charges-calculator',       handoff: 'total_cost_bps and riy feed Stage 5 Form CRS' },
      { slug: '464-form-crs-generator',                   handoff: 'Exports composite Reg BI suitability Policy Mandate -- final stage' },
    ],
  },

  'bnpl-programme': {
    title: 'BNPL Programme — FCA Regulation',
    description: 'FCA BNPL readiness > affordability modelling > APR calculation > disclosure templates > arrears & collections policy. FCA BNPL regulation in force 15 Jul 2026.',
    composer_url: BASE_URL + '/guides/bnpl-programme-composer.html',
    steps: [
      { slug: '187-bnpl-fca-readiness-checker',               handoff: 'readiness_score and gap_list feed Stage 2 affordability model' },
      { slug: '190-bnpl-affordability-assessment-modeller',   handoff: 'affordability_result and repayment_schedule feed Stage 3 APR calc' },
      { slug: '193-bnpl-apr-calculator',                      handoff: 'representative_apr and total_charge feed Stage 4 disclosure templates' },
      { slug: '191-bnpl-disclosure-template-generator',       handoff: 'pcci_template and summary_box feed Stage 5 arrears assessment' },
      { slug: '192-bnpl-arrears-collections-checker',         handoff: 'Exports composite BNPL programme Policy Mandate -- final stage' },
    ],
  },

  'pi-emi-authorisation': {
    title: 'PI/EMI Authorisation — PSD2/PSRs',
    description: 'PI authorisation readiness > EMI capital requirements > PI own funds (PSD2 Art.9) > PSP safeguarding assessment > PSR APP reimbursement liability. FCA/EBA payment services perimeter.',
    composer_url: BASE_URL + '/guides/pi-emi-authorisation-composer.html',
    steps: [
      { slug: '404-payment-institution-authorisation-readiness-checker', handoff: 'readiness_gaps and business_volumes feed Stage 2 capital calc' },
      { slug: '405-emi-capital-requirements-calculator',                  handoff: 'emi_capital_requirement and method_results feed Stage 3 own funds' },
      { slug: '418-pi-own-funds-calculator',                             handoff: 'own_funds_requirement feeds Stage 4 safeguarding assessment' },
      { slug: '269-psp-safeguarding-assessment',                         handoff: 'safeguarding_method and shortfall feed Stage 5 APP liability' },
      { slug: '406-psr-app-reimbursement-liability-splitter',            handoff: 'Exports composite PI/EMI authorisation Policy Mandate -- final stage' },
    ],
  },

  // Wave 5 high-TAM workflow composers
  'crypto-tax-reporting': {
    title: 'Crypto-Asset Tax Reporting (CARF / DAC8 / 1099-DA)',
    description: 'End-to-end crypto-asset tax reporting workflow: CARF/DAC8 reportable classification > cost-basis and gain/loss calculation > IRS Form 1099-DA assembly > CASP readiness scoring. Covers OECD CARF, EU DAC8, and US TD 9996 (1099-DA). ⚠ US-CARF exchange not effective until 2027.',
    composer_url: BASE_URL + '/chaingraph/chains/crypto-tax-reporting.html',
    steps: [
      { slug: '465-carf-dac8-reportable-classifier',        handoff: 'reportable_users and reportable_txns feed Stage 2 basis calc' },
      { slug: '466-crypto-cost-basis-gain-calculator',      handoff: 'gain_loss_schedule feeds Stage 3 1099-DA assembly' },
      { slug: '467-form-1099-da-generator',                 handoff: 'filing_records feed Stage 4 readiness scoring' },
      { slug: '468-casp-tax-reporting-readiness-scorer',    handoff: 'Exports crypto-tax reporting Policy Mandate -- final stage' },
    ],
  },

  'bank-capital-liquidity': {
    title: 'Bank Capital & Liquidity (Basel III)',
    description: 'Full Basel III capital and liquidity workflow: RWA calculation > LCR > NSFR > leverage ratio > Pillar 3 disclosure. Covers BCBS 189, 238, 295, 270/360, 309/400.',
    composer_url: BASE_URL + '/chaingraph/chains/bank-capital-liquidity.html',
    steps: [
      { slug: '201-basel-rwa-calculator',             handoff: 'rwa_total and credit/market/ops breakdown feed Stage 2 LCR' },
      { slug: '469-lcr-calculator',                   handoff: 'hqla_total and nco feed Stage 3 NSFR' },
      { slug: '470-nsfr-calculator',                  handoff: 'asf and rsf totals feed Stage 4 leverage ratio' },
      { slug: '471-leverage-ratio-calculator',        handoff: 'tier1 and exposure measure feed Stage 5 Pillar 3 disclosure' },
      { slug: '472-pillar-3-disclosure-builder',      handoff: 'Exports composite Basel III capital & liquidity Policy Mandate -- final stage' },
    ],
  },

  'pillar-two-globe': {
    title: 'Pillar Two GloBE Minimum Tax',
    description: 'OECD Pillar Two GloBE end-to-end workflow: ETR per jurisdiction > top-up tax and QDMTT/IIR/UTPR allocation > safe harbour eligibility > GloBE Information Return (GIR). 15% global minimum ETR. ⚠ US-HQ groups exempt from IIR and UTPR per the OECD January 2026 side-by-side package. First GIR filings due 30 June 2026.',
    composer_url: BASE_URL + '/chaingraph/chains/pillar-two-globe.html',
    steps: [
      { slug: '473-globe-etr-jurisdiction-calculator',      handoff: 'etr_by_jur and sbie_amounts feed Stage 2 top-up tax calc' },
      { slug: '474-topup-tax-qdmtt-calculator',             handoff: 'topup_amounts and qdmtt_allocation feed Stage 3 safe harbour check' },
      { slug: '475-pillar-two-safe-harbour-checker',        handoff: 'safe_harbour_flags feed Stage 4 GIR Builder' },
      { slug: '476-gir-builder',                            handoff: 'Exports composite Pillar Two GloBE Policy Mandate -- final stage' },
    ],
  },

  // Wave 6 — EU Consumer Credit (CCD2)
  'ccd2-consumer-credit': {
    title: 'EU Consumer Credit (CCD2)',
    description: 'Scope classification > Art. 18 creditworthiness > SECCI pre-contractual disclosure > readiness. CCD2 (Directive (EU) 2023/2225) applies from 20 Nov 2026; brings BNPL and interest-free instalments into scope EU-wide. Full audited run in the composer.',
    composer_url: BASE_URL + '/guides/ccd2-consumer-credit-composer.html',
    steps: [
      { slug: '481-ccd2-scope-classifier',                          handoff: 'in_scope_products and obligation_tier feed Stage 2' },
      { slug: '482-ccd2-creditworthiness-assessment-builder',       handoff: 'assessment_framework feeds Stage 3 disclosure' },
      { slug: '483-ccd2-secci-precontractual-disclosure-generator', handoff: 'disclosure_set feeds Stage 4 readiness scoring' },
      { slug: '484-ccd2-readiness-scorer',                          handoff: 'Exports CCD2 Policy Mandate -- final stage' },
    ],
  },

  // Wave 6 — EU AML Single Rulebook (AMLR)
  'amlr-single-rulebook': {
    title: 'EU AML Single Rulebook (AMLR)',
    description: 'Obliged-entity scope > UBO / beneficial ownership > cash limit & EDD classification > CDD policy > readiness. AMLR (Regulation (EU) 2024/1624) applies from 10 Jul 2027; football-club provisions 2029.',
    composer_url: BASE_URL + '/chaingraph/chains/aml-consolidation.html',
    steps: [
      { slug: '485-amlr-obliged-entity-scope-mapper',          handoff: 'entity_type and obligations feed Stage 2 UBO mapping' },
      { slug: '486-amlr-ubo-beneficial-ownership-mapper',      handoff: 'ubo_tier and edd_triggers feed Stage 3 cash/EDD classifier' },
      { slug: '487-amlr-cash-limit-edd-classifier',            handoff: 'cash_verdict and edd_flags feed Stage 4 CDD policy builder' },
      { slug: '488-amlr-cdd-policy-builder',                   handoff: 'cdd_tier_config feeds Stage 5 readiness' },
      { slug: '350-amla-2027-readiness-gap-analyzer',          handoff: 'Exports composite AML Policy Mandate -- final stage' },
    ],
  },

  // Wave 6 — eIDAS 2.0 / EUDI Wallet acceptance
  'eudi-wallet-acceptance': {
    title: 'eIDAS 2.0 / EUDI Wallet Acceptance',
    description: 'Attribute attestation mapping > wallet-based KYC flow design > RP registration check > readiness scoring. eIDAS 2.0 (Regulation (EU) 2024/1183); EUDI Wallet available all EU MS 31 Dec 2026; FI SCA acceptance ~Dec 2027 (Art. 5f).',
    composer_url: BASE_URL + '/chaingraph/chains/eudi-wallet.html',
    steps: [
      { slug: '489-eudi-attribute-attestation-mapper',              handoff: 'pid_attributes and qeaa_map feed Stage 2 KYC flow' },
      { slug: '490-eudi-kyc-flow-designer',                        handoff: 'kyc_flow_steps feed Stage 3 RP registration check' },
      { slug: '491-eudi-relying-party-registration-checker',       handoff: 'rp_registration_status feeds Stage 4 readiness' },
      { slug: '348-eidas2-eudi-wallet-relying-party-readiness-scorer', handoff: 'Exports EUDI Acceptance Mandate -- final stage' },
    ],
  },

  // Wave 6 — Nacha Phase 2 ACH Fraud Monitoring (effective 2026-06-22)
  'ach-fraud-monitoring': {
    title: 'ACH Fraud Monitoring (Nacha Phase 2)',
    description: 'Procedure builder (role-based) > false-pretenses scenario simulator > annual audit pack generator. Nacha Phase 2 removes the $5M volume threshold; effective 2026-06-22. All RDFI, Originator, TPSP, TPS, and ODFI participants must have risk-based credit-entry fraud monitoring in place.',
    composer_url: BASE_URL + '/chaingraph/chains/ach-fraud-monitoring.html',
    steps: [
      { slug: '492-ach-fraud-monitoring-procedure-builder',      handoff: 'roles and risk_tier feed Stage 2 scenario simulator and Stage 3 audit pack' },
      { slug: '493-ach-false-pretenses-credit-entry-simulator',  handoff: 'scenario obligations and recovery path inform Stage 3 gap identification' },
      { slug: '494-ach-fraud-monitoring-audit-pack-generator',   handoff: 'Exports annual review audit binder + composite ACH Fraud Policy Mandate -- final stage' },
    ],
  },

  // Wave 7 — Post-Quantum Cryptography Migration
  'pqc-migration': {
    title: 'Post-Quantum Cryptography Migration',
    description: 'End-to-end PQC migration workflow: crypto asset inventory (NISTIR 8547 classification) > HNDL quantum risk scoring > phased migration roadmap (FIPS 203/204/205) > crypto-agility readiness score. Composite PQC migration mandate. RSA/ECDSA/ECDH/DH deprecated 2030, disallowed 2035; DSA already disallowed.',
    composer_url: BASE_URL + '/chaingraph/chains/pqc-migration.html',
    steps: [
      { slug: '499-crypto-asset-inventory-classifier',  handoff: 'classified_assets and algorithm_status feed Stage 2 HNDL risk scoring' },
      { slug: '500-hndl-quantum-risk-scorer',           handoff: 'hndl_priority per system (immediate/within_2_years/within_5_years/post_2030/monitor) feed Stage 3 roadmap' },
      { slug: '501-pqc-migration-roadmap-builder',      handoff: 'migration_phases and target_algorithms (ML-KEM/ML-DSA/SLH-DSA) feed Stage 4 agility assessment' },
      { slug: '502-crypto-agility-readiness-scorer',    handoff: 'Exports composite PQC migration Policy Mandate -- final stage' },
    ],
  },

  // Wave 6 — Agentic Commerce Merchant Readiness
  'agentic-checkout': {
    title: 'Agentic Checkout Protocol Readiness',
    description: 'Protocol selector (UCP/ACP/x402/Visa TAP) > ACP/UCP product-feed conformance auditor > agent-traffic acceptance policy builder. Produces a composite Policy Mandate covering protocol recommendation, feed conformance gaps, and agent-guardrail policy. T497 x402 Micropayment Pricing Modeler is a standalone branch tool.',
    composer_url: BASE_URL + '/guides/agentic-checkout-composer.html',
    steps: [
      { slug: '495-agentic-checkout-protocol-selector',          handoff: 'protocol_recommendation and stack_config feed Stage 2 conformance auditor' },
      { slug: '496-acp-ucp-product-feed-conformance-auditor',    handoff: 'conformance_gaps and fix_checklist feed Stage 3 acceptance policy' },
      { slug: '498-agent-traffic-acceptance-policy-builder',     handoff: 'Exports agent-traffic acceptance Policy Mandate -- final stage' },
    ],
  },

  // Wave 6 ChainGraph — Agent Commerce Cross-Protocol Conformance
  'agent-commerce-conformance': {
    title: 'Agent Commerce Cross-Protocol Conformance',
    description: 'AP2 v0.2 mandate chain > ACP checkout conformance > x402 settlement modelling > unified cross-protocol conformance verdict. Validates one agent purchase end-to-end: AP2 Intent→Cart→Payment + ACP CheckoutRequest + Visa TAP RFC 9421 HTTP Message Signature + x402 settlement leg. Issues a single execution_hash receipt covering all four protocols (ChainGraph Standard v0.1).',
    composer_url: BASE_URL + '/chaingraph/chains/agent-commerce-conformance.html',
    steps: [
      { slug: 'art-01-ap2-mandate-chain-validator',          handoff: 'ap2_mandate and execution_hash (H1) feed Stage 2 ACP checkout conformance' },
      { slug: 'art-12-acp-checkout-conformance-validator',   handoff: 'acp_verdict and conformance_flags + execution_hash (H2) feed Stage 3 x402 settlement model' },
      { slug: 'art-03-x402-settlement-modeler',              handoff: 'x402_payload and settlement execution_hash (H3) feed Stage 4 cross-protocol validator' },
      { slug: 'art-30-agent-commerce-conformance-validator', handoff: 'Exports unified AP2+ACP+TAP+x402 cross-protocol conformance mandate; execution_hash (H4) covers full transaction -- final stage' },
    ],
  },

  // Wave 6 ChainGraph — Agent Identity & Trust-Chain
  'agent-identity-trust': {
    title: 'Agent Identity & Trust-Chain',
    description: 'A2A agent-card + delegated-authority trust-chain validation > KYA-OS identity attestation > spend-policy simulation. The horizontal agent-to-agent trust complement: who is the agent, what is it authorized to do, does its spend policy hold. Each node emits a hash-anchored ChainGraph artifact.',
    composer_url: BASE_URL + '/chaingraph/chains/agent-identity-trust.html',
    steps: [
      { slug: 'art-32-a2a-agent-card-trust-chain-validator', handoff: 'a2a_card + trust-chain verdict and execution_hash feed Stage 2 KYA attestation' },
      { slug: 'art-04-agent-identity-attestation-checker',   handoff: 'attestation verdict and execution_hash feed Stage 3 spend-policy simulation' },
      { slug: 'art-02-agent-spend-policy-simulator',         handoff: 'Exports the agent-identity-trust policy artifact -- final stage' },
    ],
  },

  // Wave 6 ChainGraph — MCP Server Attestation
  'mcp-server-attestation': {
    title: 'MCP Server Attestation',
    description: 'MCP deployability diagnostic > developer readiness scorecard > signed server self-attestation (composite A-F grade). Dogfooding -- the AINumbers MCP server can attest itself. Each node emits a hash-anchored ChainGraph artifact.',
    composer_url: BASE_URL + '/chaingraph/chains/mcp-server-attestation.html',
    steps: [
      { slug: 'art-28-mcp-server-deployability-diagnostic', handoff: 'deployability grade and execution_hash feed Stage 2 readiness scorecard' },
      { slug: 'art-18-mcp-developer-readiness-scorecard',   handoff: 'readiness score and execution_hash feed Stage 3 self-attestation' },
      { slug: 'art-33-mcp-server-self-attestation-pack',    handoff: 'Exports the composite MCP server attestation artifact -- final stage' },
    ],
  },

  // Wave 9 ChainGraph — Tempo Network
  'tempo-fit': {
    title: 'Tempo Fit Diagnostic',
    description: 'Single-node D0 diagnostic grading an organisation A–F across four Tempo use cases (Issue/TIP-20, Payments rail, Agent/MPP, Commerce/checkout). Routes to W-A, W-B, W-C, or W-D chain based on dimension scores.',
    composer_url: BASE_URL + '/chaingraph/chains/tempo-fit.html',
    steps: [
      { slug: 'art-34-tempo-fit-diagnostic', handoff: 'dim_scores and primary_recommendation route to tempo-payments / tempo-issuance / tempo-mpp-agent / tempo-agentic-checkout chains' },
    ],
  },

  'tempo-payments': {
    title: 'Tempo Payments Business Case',
    description: 'W-A chain. Models CFO-level cost savings of migrating payroll, remittance, or merchant settlement to Tempo vs card/SWIFT/ACH/SEPA. Outputs annual savings ($, bps), break-even months, finality improvement, and a CFO memo.',
    composer_url: BASE_URL + '/chaingraph/chains/tempo-payments.html',
    steps: [
      { slug: 'art-35-tempo-payments-business-case', handoff: 'annual_savings, per_tx_saving, break_even_months, and cfο_memo feed downstream issuance or agent chains' },
    ],
  },

  'tempo-mpp-agent': {
    title: 'Tempo MPP Agent Mandate',
    description: 'W-C chain. Decode MPP session → AP2 mandate chain validation → agent spend-policy simulation → KYA identity attestation. The agent emits the mandate; the merchant re-verifies execution_hash before honoring the HTTP-402 response.',
    composer_url: BASE_URL + '/chaingraph/chains/tempo-mpp-agent.html',
    steps: [
      { slug: 'art-36-tempo-mpp-agent-mandate',      handoff: 'session_mandate and execution_hash (H1) + AP2 mapping feed Stage 2 mandate validation' },
      { slug: 'art-01-ap2-mandate-chain-validator',  handoff: 'ap2_mandate verdict and execution_hash (H2) feed Stage 3 spend-policy simulation' },
      { slug: 'art-02-agent-spend-policy-simulator', handoff: 'spend_policy verdict and execution_hash (H3) feed Stage 4 KYA attestation' },
      { slug: 'art-04-agent-identity-attestation-checker', handoff: 'Exports composite MPP agent mandate with execution_hash (H4) -- final stage' },
    ],
  },

  'tempo-issuance': {
    title: 'Tempo Stablecoin Issuance',
    description: 'W-B chain. TIP-20 config lint + TIP-403 policy design → GENIUS Act reserve pre-check → AML typology pre-screen. Dual US GENIUS PPSI + EU MiCA EMT compliance. GENIUS Act enacted; GENIUS PPSI AML Rule Fed. Reg. 2026-06963 NPRM.',
    composer_url: BASE_URL + '/chaingraph/chains/tempo-issuance.html',
    steps: [
      { slug: 'art-37-tempo-stablecoin-issuance',         handoff: 'genius_checks, mica_checks, overall_verdict, and issuer_lei feed Stage 2 reserve pre-check' },
      { slug: 'art-06-genius-act-reserve-attestation',    handoff: 'reserve_attestation verdict feeds Stage 3 AML pre-screen' },
      { slug: 'art-10-amla-transaction-typology-risk-scorer', handoff: 'Exports composite stablecoin issuance compliance mandate -- final stage' },
    ],
  },

  'tempo-onchain-aml': {
    title: 'Tempo On-Chain AML',
    description: 'W-E chain. TIP-403 freeze/allowlist pre-check → TIP-20 batch AML + FATF Travel Rule screening → typology risk scoring. Bilateral: sending VASP emits Travel Rule attestation; receiving VASP re-verifies. FATF ≥$3,000; BSA SAR ≥$5,000.',
    composer_url: BASE_URL + '/chaingraph/chains/tempo-onchain-aml.html',
    steps: [
      { slug: 'art-37-tempo-stablecoin-issuance',             handoff: 'tip403_controls verified before batch screening' },
      { slug: 'art-38-tempo-onchain-aml',                     handoff: 'sar_determination, travel_rule_attestation, and execution_hash feed Stage 3 typology scoring' },
      { slug: 'art-10-amla-transaction-typology-risk-scorer', handoff: 'Exports composite AML + Travel Rule mandate -- final stage' },
    ],
  },

  'tempo-zone-disclosure': {
    title: 'Tempo Zone Disclosure',
    description: 'W-F chain. Operator AML screen on full Zone tx set → selective-disclosure attestation → ZK compliance proof. Confirms TIP-403 propagates cross-zone. Zones: operator sees all, users see own, outsiders see ZK proofs (June 2026).',
    composer_url: BASE_URL + '/chaingraph/chains/tempo-zone-disclosure.html',
    steps: [
      { slug: 'art-38-tempo-onchain-aml',         handoff: 'aml_verdict and execution_hash (H1) feed Stage 2 zone disclosure attestation' },
      { slug: 'art-39-tempo-zone-disclosure',     handoff: 'zone_attestation verdict and execution_hash (H2) feed Stage 3 ZK proof generation' },
      { slug: 'cry-01-zk-compliance-proof-generator', handoff: 'Exports privacy-and-auditability attestation + ZK proof -- final stage' },
    ],
  },

  'tempo-agentic-checkout': {
    title: 'Tempo Agentic Checkout',
    description: 'W-D chain. x402/MPP protocol decode → TIP-20 settlement mapper. ART-40 is the canonical OCG v0.3 pacs.008-subset tool: maps 32-byte Tempo memo → ISO 20022 remittance_information. Merchant emits; agent re-verifies execution_hash before honoring settlement.',
    composer_url: BASE_URL + '/chaingraph/chains/tempo-agentic-checkout.html',
    steps: [
      { slug: 'art-26-x402-payload-decoder-flow-simulator', handoff: 'protocol_decode and payment_details feed Stage 2 TIP-20 settlement mapping' },
      { slug: 'art-40-tempo-agentic-checkout',              handoff: 'Exports TIP-20 settlement artifact with execution_hash; memo → remittance_information crosswalk -- final stage' },
    ],
  },

  // Wave 9 fast-follow — Tempo Validator Readiness (standalone node, no chain page)
  'tempo-validator-readiness': {
    title: 'Tempo Validator Readiness',
    description: 'ART-41 standalone node. 12-question infrastructure readiness scorer for prospective Tempo validators across hardware, OS/software, key management, telemetry, and upgrade cadence. Flags permissioned entry (partners@tempo.xyz required). infrastructure_mandate.',
    composer_url: BASE_URL + '/chaingraph/chains/tempo-validator-readiness.html',
    steps: [
      { slug: 'art-41-tempo-validator-readiness', handoff: 'Exports infrastructure_mandate artifact with execution_hash and permissioning notice -- standalone node' },
    ],
  },

  // Wave 8 — Canton / Tokenized Market Infrastructure
  'canton-capital-efficiency': {
    title: 'Canton Capital Efficiency Chain',
    description: 'Assess Canton pilot readiness and compute settlement-risk capital savings. Steps: Canton Readiness Diagnostic → Capital Optimizer → Basel 3.1 RWA → XVA/CVA → LCR/NSFR.',
    composer_url: BASE_URL + '/chaingraph/chains/canton-capital-efficiency.html',
    steps: [
      { slug: '503-canton-tokenization-readiness-diagnostic', handoff: 'entity_type,grade,gaps feed Stage 2 capital optimizer' },
      { slug: '504-settlement-risk-capital-optimizer',        handoff: 'total_rwa_delta,annual_saving_bps feeds downstream Basel 3.1/XVA/LCR chain -- final stage' },
    ],
  },
  'canton-dvp-readiness': {
    title: 'Canton DvP Readiness Chain',
    description: 'Validate DvP atomicity and collateral eligibility for Canton settlement. PFMI P12 atomicity model + DTC/Fed/HQLA eligibility verdict.',
    composer_url: BASE_URL + '/chaingraph/chains/canton-dvp-readiness.html',
    steps: [
      { slug: '507-canton-dvp-atomicity-validator',           handoff: 'dvp_verdict,atomicity_model,finality_model feed Stage 2 collateral eligibility' },
      { slug: '505-tokenized-collateral-eligibility-checker', handoff: 'hqla_tier,dtc_eligible,haircut_pct -- Exports DvP readiness mandate -- final stage' },
    ],
  },
  'canton-repo-mobility': {
    title: 'Canton Repo Collateral Mobility Chain',
    description: 'Compute repo haircut with Canton 24/7 valuation, verify collateral and cash-leg finality. CRE22 supervisory haircuts + d349 SFT floors.',
    composer_url: BASE_URL + '/chaingraph/chains/canton-repo-mobility.html',
    steps: [
      { slug: '508-repo-haircut-collateral-calculator',       handoff: 'total_haircut_pct,initial_margin,canton_247 feed Stage 2 collateral eligibility' },
      { slug: '505-tokenized-collateral-eligibility-checker', handoff: 'hqla_tier,dtc_eligible feed Stage 3 cash-leg finality' },
      { slug: '506-onchain-cash-leg-finality-checker',        handoff: 'finality_verdict,genius_status -- Exports repo collateral mandate -- final stage' },
    ],
  },
  'canton-counterparty-onboarding': {
    title: 'Canton Counterparty Onboarding Chain',
    description: 'KYA screening and party allowlist validation for Canton Network onboarding. FATF Travel Rule compliance and AMLAR KYA obligations.',
    composer_url: BASE_URL + '/chaingraph/chains/canton-counterparty-onboarding.html',
    steps: [
      { slug: '509-canton-party-allowlist-validator', handoff: 'allowlist_verdict,fatf_flags,parties_approved -- Exports counterparty onboarding mandate -- final stage' },
    ],
  },
  'canton-securities-issuance': {
    title: 'Canton Securities Issuance Chain',
    description: 'Regulatory classification and Daml lifecycle validation for tokenized securities. GENIUS/MiCA/MiFID II/DLT Pilot classification then lifecycle coverage.',
    composer_url: BASE_URL + '/chaingraph/chains/canton-securities-issuance.html',
    steps: [
      { slug: '510-digital-asset-regulatory-classifier',      handoff: 'frameworks_applied,mifid_instrument,dlt_pilot_eligible feed Stage 2 lifecycle validator' },
      { slug: '512-tokenized-security-lifecycle-validator',   handoff: 'lifecycle_verdict,daml_gaps -- Exports securities issuance mandate -- final stage' },
    ],
  },
  'canton-margin-call': {
    title: 'Canton Margin Call & Collateral Mobilization Chain',
    description: 'Margin computation (UMR/d499 for derivatives; GMRA/d349 for repo/SFT), collateral eligibility, and cash-leg finality. Never mixes UMR and GMRA branches.',
    composer_url: BASE_URL + '/chaingraph/chains/canton-margin-call.html',
    steps: [
      { slug: '513-margin-call-collateral-mobilizer',         handoff: 'branch,margin_required,collateral_gap feed Stage 2 collateral eligibility' },
      { slug: '505-tokenized-collateral-eligibility-checker', handoff: 'hqla_tier,eligible_value feed Stage 3 cash-leg finality' },
      { slug: '506-onchain-cash-leg-finality-checker',        handoff: 'finality_verdict -- Exports margin call collateral mandate -- final stage' },
    ],
  },

  // Wave 6 ChainGraph — Agent Session Receipt (links-only aggregator)
  'agent-session-receipt': {
    title: 'Agent Session Receipt',
    description: 'Aggregate N execution_hashes from an agent session into one SHA-256 Merkle-root session receipt (CRY-05) > regulator-framed prompt (PTG-01). One tamper-evident audit object for EU AI Act Art. 12 / DORA.',
    composer_url: BASE_URL + '/chaingraph/chains/agent-session-receipt.html',
    steps: [
      { slug: 'cry-05-agent-action-audit-trail-aggregator', handoff: 'session_receipt_root (Merkle root over all session execution_hashes) feeds Stage 2 prompt generation' },
      { slug: 'ptg-01-ap2-prompt-template-generator',       handoff: 'Generates a regulator-framed prompt citing the full session receipt -- final stage' },
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
  const manifests = {};
  for (const slug of PILOT) {
    manifests[slug] = await (await get('manifests/' + slug + '.manifest.json')).json();
  }
  // Widget HTML bodies load LAZILY (only when a widget resource is actually READ), NOT eagerly
  // per PILOT here. On the Cloudflare FREE plan (50 subrequests/invocation) eager-loading every
  // widget's HTML at cold start put buildServer right at the ceiling; adding one widget (VM-1a
  // run_kernel_vm, PILOT #16) tipped it over — and a poisoned cold isolate throws before dataCache
  // is set, so EVERY subsequent call to it also failed (persistent /mcp tools/call outage,
  // 2026-07-09; reverted in #57, re-landed with this fix). Manifests stay eager (needed for tool
  // names at registration); the big HTML bodies are fetched on demand and cached per isolate.
  const widgets = {};
  const loadWidget = async (slug) =>
    (widgets[slug] ??= stripCspMeta(await (await get('tools/' + slug + '.html')).text()) + glue);
  const catalog = await (await get('mcp/catalog.json')).json();
  const chaingraph = await (await get('chaingraph/chaingraph.json')).json();
  const searchIndex = await (await get('search-index.json')).json();
  const chainFixtures = await (await get('chain-fixtures.json')).json();
  dataCache = { manifests, widgets, loadWidget, catalog, chaingraph, searchIndex, chainFixtures };
  return dataCache;
}

// Advertised core (MCP-500-1 §M1.1): the lean-default set every client sees as "always resident,
// never deferred" — 6 utility tools + the discovery/execution trio (find_tool/find_chain/run_chain).
// Exactly these 9 names, ONE named constant (never scattered literals). Everything else (the other
// ~325 utility/PILOT/ChainGraph tools) gets defaultConfig:{defer_loading:true} injected below and is
// surfaced on demand through find_tool/find_chain — the Anthropic tool-search pattern (49%→74%
// selection-accuracy lift at 300+ tools; most MCP clients truncate the advertised list ~40 tools in).
const HOT_TOOLS = new Set([
  'list_ainumbers_tools', 'build_workflow_links', 'verify_execution_hash',
  'build_chaingraph', 'emit_chaingraph_artifact', 'build_session_receipt',
  'find_tool', 'find_chain', 'run_chain',
]);

// ── §M1.6 dual-version window (MCP 2026-07-28 RC pin) ───────────────────────
// RC revision pinned: draft dated 2026-06-xx, "Streamable HTTP: initialize + sessions optional"
// (drops the MANDATORY initialize handshake + session ids). A later RC revision that changes this
// shape should be a one-file diff here. This worker is ALREADY stateless — every request builds a
// fresh transport/server (sessionIdGenerator: undefined, no cached McpServer) and every JSON-RPC
// method below (tools/list, tools/call, ...) is handled independently of whether `initialize` was
// ever called on this "connection" — there is no connection, no session memory. So BOTH the current
// (initialize-first) handshake AND the RC (no-initialize, call tools/list or tools/call directly)
// handshake already work unmodified; scripts/smoke-mcp.mjs proves both paths green post-deploy.
// `initialize` itself stays supported (never removed) for clients still on the current spec rev.

// ── O(1) static discovery — per-method, no large parse ─────────────────────
// The Worker runs on the Cloudflare FREE plan (~10ms CPU/request). The four discovery responses
// are immutable per deploy and captured at build time (scripts/precompute-discovery.mjs).
//   • initialize → a tiny parsed object (protocolVersion is echoed from the request).
//   • the LIST responses (tools/list is ~330KB) → served as PRE-FRAMED SSE TEXT with an
//     "id":__OCG_ID__ placeholder. Splicing the id is a single cheap string replace, so a cold
//     isolate never JSON.parses NOR re-stringifies the 330KB tools/list — that parse+stringify was
//     the dominant cold-start CPU cost burning the 10ms budget.
// Per-method: each request fetches ONLY its own asset (1 subrequest, not 4). Cached per isolate.
const STATIC_DISCOVERY_METHODS = new Set(['initialize', 'tools/list', 'resources/list', 'prompts/list']);
const STATIC_LIST_FILE = {
  'tools/list':     'mcp/static/tools-list.sse.txt',
  'resources/list': 'mcp/static/resources-list.sse.txt',
  'prompts/list':   'mcp/static/prompts-list.sse.txt',
};
const ID_PLACEHOLDER = '__OCG_ID__';
let _initStatic = null;
const _listStatic = {};
async function getStaticInitialize(env) {
  if (_initStatic) return _initStatic;
  const r = await env.ASSETS.fetch('https://assets.local/mcp/static/initialize.json');
  if (!r.ok) throw new Error('static initialize asset miss: ' + r.status);
  return (_initStatic = await r.json());
}
// Named toolsets (§M1.2): known profile names, loaded lazily from the vendored manifest so a new
// profile added by generate.mjs is picked up without a worker.mjs edit. `?toolset=<name>` on /mcp
// selects the matching precomputed tools-list.<name>.sse.txt (generator-emitted, §M1.2); an unknown
// or absent name falls back to the lean-core default file — never a 4xx for an unrecognized profile.
let _toolsetNames = null;
async function getToolsetNames(env) {
  if (_toolsetNames) return _toolsetNames;
  try {
    const r = await env.ASSETS.fetch('https://assets.local/mcp/toolsets.json');
    const j = r.ok ? await r.json() : { profiles: {} };
    return (_toolsetNames = new Set(Object.keys(j.profiles ?? {})));
  } catch { return (_toolsetNames = new Set()); }
}
async function getStaticListTemplate(env, method, toolset) {
  const key = toolset ? method + ':' + toolset : method;
  if (_listStatic[key]) return _listStatic[key];
  const file = toolset ? STATIC_LIST_FILE[method].replace('.sse.txt', '.' + toolset + '.sse.txt') : STATIC_LIST_FILE[method];
  const r = await env.ASSETS.fetch('https://assets.local/' + file);
  if (!r.ok) throw new Error('static list asset miss: ' + key + ' > ' + r.status);
  return (_listStatic[key] = await r.text());   // TEXT — no JSON.parse of the large body
}

// BM25 scorer (Workers-runtime safe — no Node APIs).
function bm25Search(query, index, { k1 = 1.2, b = 0.75, topN = 5 } = {}) {
  const terms = query.toLowerCase()
    .replace(/[^a-z0-9_-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
  if (!terms.length) return index.docs.slice(0, topN).map(d => ({ ...d, _score: 0 }));
  const { docs, tfs, docLengths, avgDocLength, idf } = index;
  const scores = new Array(docs.length).fill(0);
  for (const t of terms) {
    const idfScore = idf[t] ?? 0;
    if (!idfScore) continue;
    for (let i = 0; i < docs.length; i++) {
      const tf = tfs[i][t] ?? 0;
      if (!tf) continue;
      scores[i] += idfScore * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * docLengths[i] / avgDocLength));
    }
  }
  return docs
    .map((doc, i) => ({ ...doc, _score: scores[i] }))
    .filter(d => d._score > 0)
    .sort((a, b2) => b2._score - a._score)
    .slice(0, topN);
}

// Ledger fragment codec — response metadata only, never inside any artifact preimage.
// Returns { ledger_url } when compressed payload ≤ 30KB, else { ledger_url_note }.
// Uses pipeThrough to avoid write/read backpressure deadlock on large inputs.
async function fragmentLink(artifact) {
  const json = JSON.stringify(artifact);
  const encoded = new TextEncoder().encode(json);
  const stream = new ReadableStream({
    start(ctrl) { ctrl.enqueue(encoded); ctrl.close(); },
  }).pipeThrough(new CompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  const compressed = new Uint8Array(buf);
  if (compressed.length > 30 * 1024) {
    return { ledger_url_note: 'artifact exceeds link budget - download and drag into ledger.ainumbers.co' };
  }
  let bin = '';
  for (let i = 0; i < compressed.length; i++) bin += String.fromCharCode(compressed[i]);
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return { ledger_url: 'https://ledger.ainumbers.co/#a=v1.' + b64 };
}

function buildServer({ manifests, widgets, loadWidget, catalog, chaingraph, searchIndex, chainFixtures }, { onlyTool = null } = {}) {
  const server = new McpServer({ name: 'ainumbers-apps', version: '1.2.0' });
  // tools/call O(1): when a single tool is requested, register ONLY that tool instead of all ~186
  // — registering the full set per request trips the Cloudflare FREE-plan CPU limit (1102). Every
  // tool registration routes through server.registerTool (ext-apps registerAppTool + the exporters'
  // registerExportArtifact included — verified), so filter by name there; skip resources + prompts
  // entirely (not needed to answer a tools/call). No caller uses the registerTool return value, so a
  // no-op stub is safe. Still a FRESH server per request — does NOT cache the McpServer (SDK binds
  // server<->transport 1:1; caching breaks /mcp). Verified byte-identical to the full build via diff.
  if (onlyTool) {
    const _realRegisterTool = server.registerTool.bind(server);
    const _stub = { enabled: true, enable() {}, disable() {}, update() {}, remove() {} };
    server.registerTool = (name, ...rest) => (name === onlyTool ? _realRegisterTool(name, ...rest) : _stub);
    server.registerResource = () => _stub;
    server.registerPrompt = () => _stub;
  }

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
      contents: [{ uri, mimeType: RESOURCE_MIME_TYPE, text: await loadWidget(slug) }],
    }));
  }

  server.registerTool('list_ainumbers_tools', {
    title: 'List AINumbers tools',
    description: 'Search the AINumbers catalog (480+ client-side fintech tools). Returns deep-links; prefill-enabled tools accept #in=<base64url(JSON of {element_id: value})>[&run=1] for one-click invocation.',
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
  // namedChains is built from chaingraph.chains (Workstream F canonical source).
  const bySlug = {}, byToolId = {};
  for (const t of catalog.tools ?? []) {
    const url = t.metadata?.url ?? '';
    const slug = url.split('/').pop().replace('.html', '');
    if (slug) bySlug[slug] = t;
    if (t.metadata?.tool_id) byToolId[t.metadata.tool_id] = t;
  }
  // Canonical chain index: read from chaingraph.json chains array (not NAMED_CHAINS literal).
  const namedChains = {};
  for (const c of chaingraph?.chains ?? []) {
    if (c.name) namedChains[c.name] = c;
  }
  const namedChainNames = Object.keys(namedChains);

  server.registerTool('build_workflow_links', {
    title: 'Build AINumbers workflow deep-links',
    description:
      'Constructs an ordered set of ready-to-use deep-links for a named AINumbers workflow chain ' +
      'or an ad-hoc sequence of tools. Each link points directly to the browser tool; ' +
      'prefill-enabled steps accept #in=<base64url(JSON)> fragments so the tool opens pre-filled. ' +
      'Zero server-side execution -- all tool logic runs deterministically in the user\'s browser. ' +
      'Use this to hand a user a complete workflow: open step 1, run it, export its Policy Mandate, ' +
      'open step 2 (pre-filled from step 1 outputs), repeat. ' +
      'Named chains: ' + namedChainNames.join(', ') + '.',
    inputSchema: {
      chain: z.string().optional().describe(
        'Name of a pre-defined chain. One of: ' + namedChainNames.join(', ') +
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
      chainMeta = namedChains[chain];
      if (!chainMeta) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Unknown chain "' + chain + '". Available: ' + namedChainNames.join(', ') }],
        };
      }
      rawSteps = chainMeta.steps.map((s) => ({ tool_id: s.tool_id, fields: undefined, _handoff: s.handoff }));
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
      let entry = bySlug[rs.tool_id] ?? byToolId[rs.tool_id];
      if (!entry) {
        // Fallback: ChainGraph nodes are served from /chaingraph/, not in catalog.json
        const cgNode = cgById[rs.tool_id];
        if (cgNode) {
          entry = {
            name: cgNode.display_name ?? cgNode.title ?? rs.tool_id,
            description: cgNode.description ?? '',
            metadata: {
              tool_id: cgNode.tool_id,
              url: cgNode.url ?? (BASE_URL + '/chaingraph/' + cgNode.tool_id + '.html'),
              prefill: false,
              ap2_export: true,
            },
          };
        }
      }
      if (!entry) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'Unknown tool_id "' + rs.tool_id + '" at step ' + (i + 1) + '. Check mcp/catalog.json for catalog tools or chaingraph.json for ChainGraph node tool_ids.' }],
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
  // ChainGraph Standard bindings (Wave 6) -- verify_execution_hash + build_chaingraph
  // Implements the ChainGraph Standard v0.1 transport binding (§8.1):
  //   - verify_execution_hash : recompute the SHA-256 execution hash of an
  //     artifact (§6) so any agent can independently verify a ChainGraph
  //     artifact -- including a third party's -- instead of trusting it.
  //   - build_chaingraph      : hash-aware sibling of build_workflow_links;
  //     returns an executable DAG over chaingraph.json nodes with explicit
  //     parent_hash wiring an agent walks (run node -> capture execution_hash
  //     -> pass as parent to children).
  // Both read-only; verify is pure compute; build reads chaingraph.json (in scope).
  // -------------------------------------------------------------------------

  // Canonicalization per ChainGraph Standard v0.1 §6: recursively sort object
  // keys (Unicode code point), preserve array order, minimal-whitespace JSON.
  // PARITY: byte-identical to repo/chaingraph/kernels/_hash.mjs (vendored to
  // ./data/kernels/_hash.mjs by generate.mjs). Every browser tool now uses that
  // same recursive canonicalizer, so a tool's exported artifact reproduces here
  // under verify_execution_hash. Do not edit one copy without the other.
  const cgCanon = (v) => Array.isArray(v) ? v.map(cgCanon)
    : (v && typeof v === 'object')
      ? Object.keys(v).sort().reduce((o, k) => (o[k] = cgCanon(v[k]), o), {})
      : v;
  async function cgExecutionHash(policy_parameters, output_payload) {
    const preimage = JSON.stringify(cgCanon({ policy_parameters, output_payload }));
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(preimage));
    // Bare hex — no 'sha256:' prefix. Matches _hash.mjs::executionHash() so kernel
    // artifacts self-verify correctly. The 'sha256:' prefix is an OPTIONAL display
    // convention used at call sites when presenting to the user (e.g. in receipts).
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // OCG §21.4 route_plan_digest — bare-hex SHA-256 over the JCS-canonical chain
  // steps[] definition (the decision policy). Same canonicalizer as §4; no new
  // hash path. Mirrors embed/runChain.mjs cgSha256Hex byte-for-byte.
  async function cgSha256Hex(obj) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(cgCanon(obj))));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  server.registerTool('verify_execution_hash', {
    title: 'Verify a ChainGraph execution hash',
    description:
      'Independently verify a ChainGraph artifact (ChainGraph Standard v0.1 §6). ' +
      'Recomputes SHA-256 over the canonical (sorted-key, whitespace-stripped) JSON of ' +
      'policy_parameters + output_payload and compares it to the claimed execution_hash. ' +
      'A match proves the artifact\'s stated inputs deterministically produce its stated outputs. ' +
      'Pass either a full artifact object, or policy_parameters + output_payload + claimed_hash. ' +
      'Pure client-safe compute -- no data is stored. Use this to verify artifacts from any vendor that conforms to the ChainGraph Standard.',
    inputSchema: {
      artifact: z.record(z.any()).optional().describe('A full ChainGraph artifact envelope (must contain policy_parameters, output_payload, and execution_hash).'),
      policy_parameters: z.record(z.any()).optional().describe('Artifact policy_parameters (if not passing a full artifact).'),
      output_payload: z.record(z.any()).optional().describe('Artifact output_payload (if not passing a full artifact).'),
      claimed_hash: z.string().optional().describe('The execution_hash to check against (if not passing a full artifact).'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ artifact, policy_parameters, output_payload, claimed_hash }) => {
    const pp = policy_parameters ?? artifact?.policy_parameters;
    const op = output_payload ?? artifact?.output_payload;
    const claimed = claimed_hash ?? artifact?.execution_hash ?? null;
    if (pp === undefined || op === undefined) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Provide a full artifact (with policy_parameters + output_payload + execution_hash) or policy_parameters + output_payload (+ claimed_hash).' }],
      };
    }
    const computed_hash = await cgExecutionHash(pp, op);
    // Tolerate the optional "sha256:" prefix (OCG spec convention) on either side.
    const __norm = (h) => (h == null ? h : String(h).replace(/^sha256:/, ''));
    const valid = claimed != null && __norm(computed_hash) === __norm(claimed);
    const out = {
      valid,
      computed_hash,
      claimed_hash: claimed,
      tool_id: artifact?.tool_id ?? null,
      chaingraph_version: artifact?.chaingraph_version ?? null,
      note: claimed == null
        ? 'No claimed hash supplied -- returning the computed hash only.'
        : (valid
          ? 'Verified: recomputed hash matches the artifact. Inputs reproduce outputs deterministically.'
          : 'MISMATCH: recomputed hash does not match the claimed hash. Treat the artifact as unverified.'),
      spec: 'ChainGraph Standard v0.1 §6',
    };
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
  });

  // RFC 6901 JSON Pointer resolution — evaluated against policy_parameters (OCG §23).
  function resolveJsonPointer(root, pointer) {
    if (pointer === '') return { ok: true, value: root };
    if (typeof pointer !== 'string' || pointer[0] !== '/') return { ok: false };
    let cur = root;
    for (const raw of pointer.slice(1).split('/')) {
      const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      if (cur == null) return { ok: false };
      if (Array.isArray(cur)) {
        if (!/^(0|[1-9]\d*)$/.test(key)) return { ok: false };
        const idx = Number(key);
        if (idx >= cur.length) return { ok: false };
        cur = cur[idx];
      } else if (typeof cur === 'object') {
        if (!Object.prototype.hasOwnProperty.call(cur, key)) return { ok: false };
        cur = cur[key];
      } else return { ok: false };
    }
    return { ok: true, value: cur };
  }
  // SHA-256 hex of the §4 cgCanon encoding of a single value — same canonicalization primitive as
  // execution_hash (imported from _hash.mjs), just hashing one resolved node instead of the
  // {policy_parameters, output_payload} pair. Bare hex; strip an optional 'sha256:' prefix to compare.
  async function attestDigestHex(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(sharedCgCanon(value)));
    const buf = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const __normDigest = (h) => (h == null ? h : String(h).replace(/^sha256:/, ''));

  // Per-type assessment for one input_attestations[] entry (OCG §23.2). Returns exactly
  // { pointer, type, structural, verifiable } — structural = pointer resolution + digest binding +
  // payload well-formedness; verifiable = the cryptographic verdict (independent of structural).
  async function assessInputAttestation(entry, policyParameters) {
    const pointer = entry?.pointer ?? null;
    const type = entry?.type ?? null;
    const proof = entry?.proof;
    const resolved = resolveJsonPointer(policyParameters, pointer);
    if (!resolved.ok) {
      return { pointer, type, structural: 'fail', verifiable: type === 'zktls' ? 'external' : 'failed' };
    }
    const expectedDigest = await attestDigestHex(resolved.value);

    if (type === 'vc-2.0') {
      const subjectDigest = __normDigest(proof?.credentialSubject?.digest);
      const structural = subjectDigest === expectedDigest ? 'pass' : 'fail';
      let verifiable = 'failed';
      try { verifiable = (await verifyProofs(proof, (did) => didKeyToPublicKey(did))) ? 'verified' : 'failed'; }
      catch { verifiable = 'failed'; }
      return { pointer, type, structural, verifiable };
    }

    if (type === 'rfc3161-snapshot') {
      let structural = 'fail';
      try { structural = extractMessageImprintHex(proof?.proof) === expectedDigest ? 'pass' : 'fail'; }
      catch { structural = 'fail'; }
      let verifiable = 'failed';
      try { await verifyRfc3161(proof, { rootPem: FREETSA_ROOT_PEM, expectHashHex: expectedDigest }); verifiable = 'verified'; }
      catch { verifiable = 'failed'; }
      return { pointer, type, structural, verifiable };
    }

    if (type === 'c2pa-manifest') {
      let structural = 'fail';
      try {
        const { output_payload } = await c2paCompute(proof ?? {});
        const hardBinding = (proof?.assertions ?? []).find((a) => a && (a.label === 'c2pa.hash.data' || a.label === 'c2pa.hash.bmff'));
        const hardBindingOk = !!hardBinding && __normDigest(hardBinding.hash) === expectedDigest;
        structural = (output_payload.manifest_valid && output_payload.has_hard_binding && hardBindingOk) ? 'pass' : 'fail';
      } catch { structural = 'fail'; }
      // Structural-only per §23.1 -- OCG validates manifest shape + hard-binding digest, not the
      // claim signature's trust chain (link-out to a full C2PA validator for that).
      return { pointer, type, structural, verifiable: 'n/a' };
    }

    if (type === 'zktls') {
      // OCG ships no zktls verifier (§23.1) -- structural digest binding only; never OCG-confirmed.
      const structural = (proof && __normDigest(proof.subject_digest) === expectedDigest) ? 'pass' : 'fail';
      return { pointer, type, structural, verifiable: 'external' };
    }

    return { pointer, type, structural: 'fail', verifiable: 'n/a' };
  }

  server.registerTool('validate_input_attestations', {
    title: 'Validate ChainGraph input attestations',
    description:
      'Verify an artifact\'s input_attestations[] (ChainGraph Standard §23): per RFC 6901 pointer, checks the ' +
      'attested value resolves inside policy_parameters and its digest binding matches, then verifies each type ' +
      'along its own path -- vc-2.0 via the shipped §16/§13.11 Data Integrity proof, rfc3161-snapshot via the ' +
      'same §20 rfc3161-tst verifier (no second RFC 3161 implementation), c2pa-manifest structurally (hard-binding ' +
      'digest match), zktls structurally-only (reported verifiable:"external" -- OCG never treats it as confirmed). ' +
      'Returns one { pointer, type, structural, verifiable } record per entry. Pure client-safe compute, zero network.',
    inputSchema: {
      artifact: z.record(z.any()).optional().describe('A full ChainGraph artifact envelope carrying input_attestations[] and policy_parameters.'),
      policy_parameters: z.record(z.any()).optional().describe('Artifact policy_parameters (if not passing a full artifact).'),
      input_attestations: z.array(z.record(z.any())).optional().describe('The input_attestations[] array (if not passing a full artifact).'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ artifact, policy_parameters, input_attestations }) => {
    const pp = policy_parameters ?? artifact?.policy_parameters;
    const attestations = input_attestations ?? artifact?.input_attestations;
    if (pp === undefined || !Array.isArray(attestations)) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Provide a full artifact (with policy_parameters + input_attestations[]) or policy_parameters + input_attestations[].' }],
      };
    }
    const results = await Promise.all(attestations.map((entry) => assessInputAttestation(entry, pp)));
    // §23 hash-exclusion sanity: input_attestations sit OUTSIDE the execution_hash preimage, so a
    // zero-attestation artifact must still be hash-identical (same pattern as §20 anchor_bindings).
    let execution_hash_unaffected = null;
    if (artifact?.policy_parameters !== undefined && artifact?.output_payload !== undefined && artifact?.execution_hash) {
      execution_hash_unaffected = __normDigest(await cgExecutionHash(artifact.policy_parameters, artifact.output_payload)) === __normDigest(artifact.execution_hash);
    }
    const all_pass = results.every((r) => r.structural === 'pass' && r.verifiable !== 'failed');
    const out = { results, all_pass, execution_hash_unaffected, spec: 'ChainGraph Standard §23' };
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
  });

  // Index chaingraph.json nodes for build_chaingraph.
  const cgNodes = chaingraph?.nodes ?? [];
  const cgById = {};
  for (const n of cgNodes) cgById[n.tool_id] = n;

  server.registerTool('build_chaingraph', {
    title: 'Build an executable ChainGraph DAG',
    description:
      'Hash-aware sibling of build_workflow_links (ChainGraph Standard v0.1 §8.1). ' +
      'Returns an ordered, executable DAG over the ChainGraph suite\'s verifiable tools, ' +
      'with explicit parent_hash wiring: which upstream execution_hash each step must cite in its chain block. ' +
      'Pass target_tool_id to build the chain that produces that node (walks consumes-edges back to roots), ' +
      'or tool_ids for an explicit ordered list, or neither to list available ChainGraph nodes. ' +
      'Agent loop: run a node, capture its execution_hash, pass it as the parent_hash for each downstream node, then verify with verify_execution_hash.',
    inputSchema: {
      target_tool_id: z.string().optional().describe('A ChainGraph node tool_id (e.g. "art-15-agent-commerce-conformance"). Builds the chain that produces it.'),
      tool_ids: z.array(z.string()).optional().describe('Explicit ordered list of ChainGraph node tool_ids to wire.'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ target_tool_id, tool_ids }) => {
    // No target -> list available nodes.
    if (!target_tool_id && (!tool_ids || tool_ids.length === 0)) {
      const nodes = cgNodes.map((n) => ({ tool_id: n.tool_id, mcp_name: n.mcp_name, mandate_type: n.mandate_type, consumes: n.consumes ?? [], feeds: n.feeds ?? [] }));
      const out = { node_count: nodes.length, nodes, note: 'Pass target_tool_id to build the chain that produces a node, or tool_ids for an explicit sequence. Graph index: ' + (chaingraph?.hub_url ?? BASE_URL + '/chaingraph/chaingraph.json') };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
    }

    const missing = [];
    let cycle = false;
    const order = [];

    if (tool_ids && tool_ids.length > 0) {
      for (const id of tool_ids) {
        const n = cgById[id];
        if (!n) { missing.push(id); continue; }
        order.push(n);
      }
    } else {
      // Topological build from target via consumes-edges (post-order = parents first).
      const seen = new Set();
      const stack = new Set();
      const visit = (id) => {
        const node = cgById[id];
        if (!node) { missing.push(id); return; }
        if (seen.has(id)) return;
        if (stack.has(id)) { cycle = true; return; }
        stack.add(id);
        for (const p of (node.consumes ?? [])) visit(p);
        stack.delete(id);
        seen.add(id);
        order.push(node);
      };
      visit(target_tool_id);
    }

    if (missing.length > 0) {
      return { isError: true, content: [{ type: 'text', text: 'Unknown ChainGraph tool_id(s): ' + missing.join(', ') + '. Call build_chaingraph with no arguments to list valid nodes.' }] };
    }

    // chain_depth = max(parent depths)+1 within this ordered set.
    const depthById = {};
    const steps = order.map((n, i) => {
      const parents = (n.consumes ?? []).filter((pid) => depthById[pid] !== undefined);
      const depth = parents.length ? Math.max(...parents.map((pid) => depthById[pid])) + 1 : 0;
      depthById[n.tool_id] = depth;
      return {
        order: i + 1,
        tool_id: n.tool_id,
        mcp_name: n.mcp_name,
        mandate_type: n.mandate_type,
        url: n.url,
        chain_depth: depth,
        consumes: n.consumes ?? [],
        // Slots the agent fills in this node's chain.parent_hashes at run time.
        parent_hash_slots: (n.consumes ?? []).map((pid) => ({ parent_tool_id: pid, parent_hash: '<execution_hash of ' + pid + ' captured earlier in this run>' })),
      };
    });

    const out = {
      target: target_tool_id ?? null,
      step_count: steps.length,
      cycle_detected: cycle,
      steps,
      verify_with: 'verify_execution_hash',
      spec: 'ChainGraph Standard v0.1 §7-§8',
      note: 'Execute in order. For each node: call its MCP tool, read execution_hash from the returned artifact, then populate the parent_hash_slots of every downstream node with it. Verify any artifact with verify_execution_hash. All decision compute is deterministic and (for browser tools) client-side.',
    };
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
  });

  // -------------------------------------------------------------------------
  // run_chain — execute a whole named chain in one MCP round-trip (v0.4 §12, chain-level).
  // Loops every kernel-backed step, threading step N's execution_hash into step N+1's
  // parent_hashes (mirrors the emit_chaingraph_artifact Mode 4 dispatch), and returns ONE
  // composite artifact whose execution_hash anchors all step outputs. compute:"browser"
  // returns a zero-egress delegation bundle (composer URL + ordered deep-links) instead of
  // running anything server-side. Deterministic; zero PII; zero payload logging. readOnlyHint:true.
  // -------------------------------------------------------------------------
  server.registerTool('run_chain', {
    title: 'Run a whole ChainGraph chain in one call',
    description:
      'Executes every step of a named chain (list names with find_chain / build_workflow_links) and returns ONE ' +
      'composite artifact whose execution_hash anchors all step outputs. ' +
      'compute:"server"/"auto" (default) runs each kernel-backed step server-side, threading step N\'s execution_hash ' +
      'into step N+1\'s parent_hashes; compute:"browser" returns a zero-egress delegation bundle (composer URL + ordered ' +
      'deep-links) to run client-side instead — no data leaves the agent. ' +
      'Supply inputs as a map of step tool_id -> policy_parameters (field names per node manifest / build_chaingraph); ' +
      'a step whose kernel needs inputs you omit is reported per-step (status "input_required"), never failed silently. ' +
      'Steps that are browser-only (gpu:true or no registered kernel) are listed for browser delegation. ' +
      'Deterministic, zero PII, zero payload logging. Verify the result with verify_execution_hash. ' +
      'Response includes a ledger_url fragment link for human verification at ledger.ainumbers.co.',
    inputSchema: {
      chain: z.string().describe('Chain name, e.g. "agent-commerce-conformance". List names with find_chain or build_workflow_links.'),
      inputs: z.record(z.record(z.any())).optional()
        .describe('Map of step tool_id -> policy_parameters overrides. Omitted steps run with {} (kernels needing required fields are reported, not failed silently).'),
      compute: z.enum(['auto', 'server', 'browser']).optional()
        .describe('"auto"/"server" (default) runs kernel-backed steps server-side; "browser" returns a zero-egress delegation bundle to run client-side.'),
      mandate: z.object({}).passthrough().optional()
        .describe('Optional §22 Work Mandate artifact. When supplied: §16 signature is verified and validity window is checked (unsigned/bad-sig/expired returns a structured error); mandate_hash is folded into every step and the composite receipt as a conditional-presence key, proving which policy governed this run. A no-mandate run is byte-identical to the pre-binding baseline (linear-hash-freeze invariant).'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ chain, inputs, compute, mandate }) => {
    const chainMeta = namedChains[chain];
    if (!chainMeta) {
      return { isError: true, content: [{ type: 'text', text: 'Unknown chain "' + chain + '". List chains with find_chain or build_workflow_links.' }] };
    }
    const steps = (chainMeta.steps ?? []).map((s) => s.tool_id);
    if (!steps.length) {
      return { isError: true, content: [{ type: 'text', text: 'Chain "' + chain + '" has no steps.' }] };
    }
    const effectiveCompute = compute ?? 'auto';

    // --- §22.5 mandate binding: verify §16 signature + validity window, derive mandate_hash ---
    const hasMandate = mandate != null && typeof mandate === 'object';
    let mandateHash = null;
    if (hasMandate) {
      const proof = mandate?.audit_signature?.proof;
      if (!proof) {
        const errOut = { error: 'mandate_unsigned', detail: 'Mandate has no §16 proof. Supply a signed mandate (audit_signature.proof required per OCG §16).' };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(errOut, null, 2) }], structuredContent: errOut };
      }
      let sigOk = false;
      try { sigOk = await verifyProofs(mandate, (did) => didKeyToPublicKey(did)); } catch (_) {}
      if (!sigOk) {
        const errOut = { error: 'mandate_bad_signature', detail: 'Mandate §16 signature verification failed (eddsa-jcs-2022).' };
        return { isError: true, content: [{ type: 'text', text: JSON.stringify(errOut, null, 2) }], structuredContent: errOut };
      }
      const vw = mandate.validity_window;
      if (vw) {
        const now = Date.now();
        if (vw.not_before && new Date(vw.not_before).getTime() > now) {
          const errOut = { error: 'mandate_not_yet_valid', detail: 'Mandate not_before is in the future.', not_before: vw.not_before };
          return { isError: true, content: [{ type: 'text', text: JSON.stringify(errOut, null, 2) }], structuredContent: errOut };
        }
        if (vw.not_after && new Date(vw.not_after).getTime() < now) {
          const errOut = { error: 'mandate_expired', detail: 'Mandate has expired.', not_after: vw.not_after };
          return { isError: true, content: [{ type: 'text', text: JSON.stringify(errOut, null, 2) }], structuredContent: errOut };
        }
      }
      mandateHash = mandate.execution_hash ?? null;
    }

    // --- compute:"browser" — zero-egress delegation, no server compute ---
    if (effectiveCompute === 'browser') {
      const stepLinks = steps.map((tid, i) => {
        const node = cgById[tid];
        return { order: i + 1, tool_id: tid, mcp_name: node?.mcp_name ?? null, browser_url: node?.url ?? (BASE_URL + '/tools/' + tid + '.html') };
      });
      const out = {
        mode: 'browser_delegation', chain, compute_mode: 'browser',
        composer_url: chainMeta.composer_url ?? null,
        step_count: steps.length, steps: stepLinks,
        note: 'Zero-egress path: run these in order in the browser (or the live runner). No data is sent to the server. ' +
          'Each tool exports a Policy Mandate; thread each execution_hash into the next via parent_hashes, or use the composer page.',
        spec: 'ChainGraph Standard v0.4 §12 (browser dispatch)',
      };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
    }

    // --- compute:"server"/"auto" — run each kernel-backed step, thread parent hashes ---
    // OCG §21: steps run in array order (linear fall-through) unless a step carries a
    // decision `gate` (§21.4) that routes control FORWARD (to a later step id or "end").
    // Steps jumped over get status "skipped_by_gate". A chain with no gate is pure linear
    // and its composite_execution_hash is UNCHANGED — every §21.4 composite key is
    // conditional-presence, emitted only when the chain defines >=1 gate. Mirrors
    // embed/runChain.mjs byte-for-byte (surface-parity gate).
    const chainSteps = chainMeta.steps ?? [];
    const hasGates = chainSteps.some((s) => s && s.gate);
    const idToIndex = {};
    chainSteps.forEach((s, i) => { idToIndex[gvStepId(s, i)] = i; });

    const results = new Array(chainSteps.length).fill(null);
    const decisions = [];
    const path_taken = [];
    let prevHash = null, prevId = null;
    let idx = 0;
    while (idx < chainSteps.length) {
      const step = chainSteps[idx];
      const tid = steps[idx];
      const node = cgById[tid];
      let ranArtifact = null;
      if (!node) { results[idx] = { order: idx + 1, tool_id: tid, status: 'unknown_node' }; }
      else if (node.gpu) { results[idx] = { order: idx + 1, tool_id: tid, status: 'gpu_browser_only', browser_url: node.url }; }
      else {
        const kernel = getKernel(tid);
        if (!kernel) { results[idx] = { order: idx + 1, tool_id: tid, status: 'no_kernel_browser_only', browser_url: node.url }; }
        else {
          const callerPp = inputs?.[tid];
          const fixturePp = chainFixtures?.[chain]?.[tid];
          const basePp = callerPp ?? fixturePp ?? {};
          const inputs_source = callerPp !== undefined ? 'caller' : (fixturePp !== undefined ? 'fixture' : 'none');
          // §22.5 conditional-presence: fold mandate_hash into step pp only when a valid mandate governs the run.
          const pp = (hasMandate && mandateHash) ? { ...basePp, mandate_hash: mandateHash } : basePp;
          try {
            const now = new Date().toISOString();
            const artifact = await kernel.buildArtifact(pp, {
              now,
              parent_hashes: prevHash ? [prevHash] : [],
              parent_tool_ids: prevId ? [prevId] : [],
              chain_depth: idx,
            });
            // §17 build_identity (advisory — which SOURCE ran; hash-excluded). Mirror Mode 4.
            const srcImg = Array.isArray(node.compute_images) && node.compute_images.find((im) => im.system === 'sha256-source');
            if (srcImg && srcImg.image_id) {
              artifact.audit_signature = { ...(artifact.audit_signature || {}), build_identity: {
                kernel_digest: srcImg.image_id,
                buildType: 'https://ainumbers.co/chaingraph/context/v0.2#WebCryptoSHA256',
                source_ref: 'kernels/' + node.tool_id + '.kernel.mjs',
              } };
            }
            // §18 compute_proof — attach iff the receipt is about THIS exact output (hash-excluded). Mirror Mode 4.
            if (node.compute_proof && node.compute_proof.journal
                && JSON.stringify(cgCanon(node.compute_proof.journal.output)) === JSON.stringify(cgCanon(artifact.output_payload))) {
              artifact.audit_signature = { ...(artifact.audit_signature || {}), compute_proof: node.compute_proof };
            }
            results[idx] = { order: idx + 1, tool_id: tid, status: 'ok', inputs_source, mandate_type: artifact.mandate_type, execution_hash: artifact.execution_hash, artifact };
            prevHash = artifact.execution_hash; prevId = tid;
            ranArtifact = artifact;
          } catch (err) {
            results[idx] = { order: idx + 1, tool_id: tid, status: 'input_required', inputs_source, error: String(err?.message ?? err),
              hint: 'Supply inputs["' + tid + '"] (field names per the node manifest / build_chaingraph).' };
          }
        }
      }
      if (results[idx].status === 'ok') path_taken.push(gvStepId(step, idx));
      // §21.4 decision gate — evaluate ONLY when the step produced output; route forward.
      if (hasGates && step && step.gate && ranArtifact) {
        const dec = { step_id: gvStepId(step, idx), ...gvEvaluateGate(step.gate, ranArtifact.output_payload) };
        decisions.push(dec);
        // §22.8.1: use isEscalationTarget/isTerminalTarget — never compare to the literal.
        if (isEscalationTarget(dec.next)) {
          // §22.8.2: HALT — mark all not-yet-run steps skipped_by_escalation (DISTINCT from skipped_by_gate).
          for (let j = idx + 1; j < chainSteps.length; j++) {
            if (results[j] === null) results[j] = { order: j + 1, tool_id: steps[j], status: 'skipped_by_escalation' };
          }
          idx = chainSteps.length; // halt
          continue;
        }
        let target;
        if (isTerminalTarget(dec.next)) target = chainSteps.length;
        else { target = idToIndex[dec.next]; if (target === undefined || target <= idx) target = idx + 1; }
        for (let j = idx + 1; j < target && j < chainSteps.length; j++) {
          if (results[j] === null) results[j] = { order: j + 1, tool_id: steps[j], status: 'skipped_by_gate' };
        }
        idx = target;
        continue;
      }
      idx++;
    }
    const resultsList = results.filter((r) => r !== null);
    // §22.8.2: detect escalation — set when any step was skipped_by_escalation.
    const escalated = resultsList.some((r) => r.status === 'skipped_by_escalation');

    const ran = resultsList.filter((r) => r.status === 'ok');
    // Composite artifact over the REAL step outputs. Deterministic preimage: only mandate_type +
    // output_payload per step (per-step timestamps/mandate_ids excluded), so the composite hash is reproducible.
    const composite_policy = {
      compute_mode: 'server',
      chain,
      chain_title: chainMeta.title ?? chain,
      step_count: ran.length,
      step_tool_ids: ran.map((r) => r.tool_id),
    };
    const composite_output = {
      chain,
      steps: ran.map((r) => ({ tool_id: r.tool_id, mandate_type: r.mandate_type, execution_hash: r.execution_hash, output_payload: r.artifact.output_payload })),
    };
    // §22.5 conditional-presence: mandate_hash enters the preimage ONLY when a mandate governed this run,
    // so every no-mandate run's composite_execution_hash stays frozen (linear-hash-freeze invariant).
    if (hasMandate && mandateHash) {
      composite_policy.mandate_hash = mandateHash;
    }
    // §21.4 conditional-presence: gate metadata enters the preimage ONLY for chains that
    // define >=1 gate, so every linear chain's composite_execution_hash stays frozen.
    if (hasGates) {
      composite_policy.route_plan_digest = await cgSha256Hex(chainSteps);
      composite_output.decisions = decisions;
      composite_output.path_taken = path_taken;
    }
    // composite_execution_hash: over RAN steps only (§22.8.2 — escalation_record is hash-excluded adjacent metadata).
    const composite_hash = ran.length ? await cgExecutionHash(composite_policy, composite_output) : null;
    const hash_valid = composite_hash ? (await cgExecutionHash(composite_policy, composite_output)) === composite_hash : null;

    // §22.8.3 open escalation record — built AFTER composite_hash (and hash_valid) so opened_at/record_hash
    // never enter the preimage. Attached to composite_output as adjacent metadata (like §20 anchor_bindings).
    let escalation_record = null;
    if (escalated) {
      const triggeringDec = decisions[decisions.length - 1]; // the decision that routed to "escalate"
      const halted_steps = resultsList.filter((r) => r.status === 'skipped_by_escalation').map((r) => gvStepId(chainSteps[r.order - 1], r.order - 1));
      // record_hash preimage: { mandate_hash?, decision, halted_steps } — opened_at EXCLUDED (§22.8.3).
      const recordPreimage = Object.assign(
        {},
        (hasMandate && mandateHash) ? { mandate_hash: mandateHash } : {},
        { decision: triggeringDec, halted_steps }
      );
      const record_hash = await cgSha256Hex(recordPreimage);
      escalation_record = {
        ...(hasMandate && mandateHash ? { mandate_hash: mandateHash } : {}),
        decision: triggeringDec,
        halted_steps,
        opened_at: new Date().toISOString(), // wall-clock, hash-EXCLUDED
        record_hash,
      };
      composite_output.escalation_record = escalation_record; // adjacent metadata — added after hash
    }

    const composite_artifact = ran.length ? {
      '@context': 'https://ainumbers.co/chaingraph/context/v0.3/context.jsonld',
      chaingraph_version: '0.4.0',
      compute_mode: 'server',
      mandate_type: 'compliance_mandate',
      tool_id: 'chaingraph/chains/' + chain,
      tool_version: '1.0.0',
      generated_at: new Date().toISOString(),
      execution_hash: composite_hash,
      chain: {
        parent_hashes: ran.map((r) => r.execution_hash),
        parent_tool_ids: ran.map((r) => r.tool_id),
        chain_depth: ran.length,
      },
      policy_parameters: composite_policy,
      output_payload: composite_output,
      compliance_flags: [],
      audit_signature: { server_side_executed: true, zero_pii_verified: true, deterministic_run: true },
    } : null;

    const out = {
      mode: 'server_run_chain', chain, compute_mode: 'server',
      step_count: chainSteps.length,
      steps_ran: ran.length,
      steps: resultsList.map((r) => ({ order: r.order, tool_id: r.tool_id, status: r.status, inputs_source: r.inputs_source ?? null, execution_hash: r.execution_hash ?? null, error: r.error ?? null, hint: r.hint ?? null })),
      composite_execution_hash: composite_hash,
      hash_valid,
      composite_artifact,
      note: escalated
        ? 'Escalated (OCG §22.8). Chain halted; human review required. See escalation_record for the open record and record_hash for the closure target.'
        : !hasGates && ran.length === chainSteps.length
          ? 'All steps ran server-side. composite_execution_hash anchors the chain; verify with verify_execution_hash. Per-step artifacts in composite_artifact.output_payload.steps.'
          : hasGates
            ? 'Gated chain (OCG §21.4). Decision gates routed control; see decisions[] and path_taken[]. Steps marked "skipped_by_gate" were bypassed by a gate. composite_execution_hash binds the route_plan_digest + decisions.'
            : 'Some steps did not run (see per-step status). Supply inputs[tool_id] for "input_required" steps, or call with compute:"browser" for browser-only steps.',
      spec: hasGates ? 'OpenChainGraph Standard v0.8 §21 Chain Execution (decision gates)' : 'ChainGraph Standard v0.4 §12 Compute Binding (chain-level)',
    };
    if (hasGates) { out.route_plan_digest = composite_policy.route_plan_digest; out.decisions = decisions; out.path_taken = path_taken; }
    if (escalation_record) out.escalation_record = escalation_record;
    // ledger_url — response metadata only; never inside any artifact preimage
    if (composite_artifact) {
      const db = await fragmentLink(composite_artifact);
      if (db.ledger_url) out.ledger_url = db.ledger_url;
      else out.ledger_url_note = db.ledger_url_note;
    }
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
  });

  // -------------------------------------------------------------------------
  // emit_chaingraph_artifact — ChainGraph Standard v0.1 §3.1
  // Makes every ChainGraph tool agent-callable as a structured artifact.
  //
  // Mode 1 — pre_computed_artifact supplied:
  //   Validates §4 required fields, recomputes execution_hash, returns verified
  //   structuredContent. Use when the browser tool has already run and exported.
  //
  // Mode 2 — tool_id + policy_parameters supplied:
  //   Returns an artifact template envelope and browser prefill URL.
  //   GPU sims always delegate to the browser (§9.2 locked; zero server-side MC).
  //
  // Mode 3 — tool_id only:
  //   Returns node metadata and artifact schema scaffold.
  //
  // readOnlyHint: true. Zero PII, zero payload logging.
  // -------------------------------------------------------------------------
  server.registerTool('emit_chaingraph_artifact', {
    title: 'Emit a ChainGraph artifact envelope',
    description:
      'Makes ChainGraph tools agent-callable (ChainGraph Standard v0.1 §3.1). ' +
      'Mode 1 — supply pre_computed_artifact (exported from the browser tool): validates §4 schema fields, recomputes execution_hash via SHA-256 over canonical {policy_parameters, output_payload}, returns verified structuredContent. ' +
      'Mode 2 — supply tool_id + policy_parameters: returns an artifact template envelope and browser prefill URL so an agent can hand the user a pre-filled link; GPU sims always delegate to the browser per §9.2. ' +
      'Mode 3 — supply tool_id only: returns node metadata and artifact schema scaffold. ' +
      'Mode 4 (Compute Binding, v0.4) — supply tool_id + policy_parameters + compute:"server" (or compute:"auto" for gpu:false nodes): runs the registered kernel server-side and returns a verified v0.4 artifact with execution_hash + output_payload in one round-trip. No browser required. gpu:true nodes always delegate to browser. ' +
      'readOnlyHint: true. Zero PII, zero payload logging. ' +
      'Pair with verify_execution_hash (independent hash verification) and build_chaingraph (DAG wiring).',
    inputSchema: {
      tool_id: z.string().optional().describe(
        'ChainGraph node tool_id (e.g. "art-01-ap2-mandate-chain-validator"). ' +
        'Looked up in chaingraph.json nodes. Required unless pre_computed_artifact is supplied.'
      ),
      policy_parameters: z.record(z.any()).optional().describe(
        'Input parameters for the tool (mirrors the tool\'s Policy Mandate input fields). ' +
        'Used for Mode 2 browser prefill and Mode 4 server-side compute.'
      ),
      compute: z.enum(['auto', 'server', 'browser']).optional().describe(
        'Compute mode (v0.4 Compute Binding). "auto" = server for gpu:false nodes (default); "server" = force server-side; "browser" = always return browser delegation URL. gpu:true nodes always use browser regardless of this flag.'
      ),
      parent_hashes: z.array(z.string()).optional().describe(
        'execution_hash values from upstream ChainGraph artifacts this call chains from. ' +
        'Placed into artifact.chain.parent_hashes (ChainGraph Standard v0.1 §5 chain block).'
      ),
      parent_tool_ids: z.array(z.string()).optional().describe(
        'tool_ids corresponding to parent_hashes, in the same order.'
      ),
      pre_computed_artifact: z.record(z.any()).optional().describe(
        'A full ChainGraph artifact envelope previously exported from the browser tool via "Export Policy Mandate". ' +
        'When supplied, the worker validates §4 required fields, recomputes execution_hash, and returns a verified structuredContent. ' +
        'This is the recommended path: run the tool in-browser, export JSON, call emit_chaingraph_artifact to verify and receive a structured receipt.'
      ),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ tool_id, policy_parameters, compute, parent_hashes, parent_tool_ids, pre_computed_artifact }) => {
    // v0.4.0 envelope: adds compute_mode + server-side kernel dispatch (Mode 4).
    // chaingraph_version + @context are canonical (match ChainGraph Standard §1).
    // ap2_version is RETIRED — never emitted. It was a misnamed envelope-version label (its value
    // "1.0" = the AINumbers Policy Mandate schema version), NOT Google AP2 (real AP2 is v0.2). See
    // CONTRACT §3.1. chaingraph_version is the sole envelope version going forward.
    const CHAINGRAPH_VERSION = '0.4.0';
    const BASE_CONTEXT = 'https://ainumbers.co/chaingraph/context/v0.3/context.jsonld';
    const ISO_CONTEXT = 'https://ainumbers.co/chaingraph/context/v0.3/iso20022-context.jsonld';
    // Acceptance only (never emitted): chaingraph_version is the canonical version field; ap2_version
    // is still TOLERATED on already-issued, pre-retirement artifacts so they keep verifying.
    const VERSION_FIELDS = ['chaingraph_version', 'ap2_version'];
    const REQUIRED_FIELDS = ['mandate_type', 'tool_id', 'tool_version', 'generated_at', 'execution_hash', 'chain', 'policy_parameters', 'output_payload'];

    // --- Mode 1: pre_computed_artifact supplied ---
    if (pre_computed_artifact) {
      const missing = REQUIRED_FIELDS.filter((f) => !(f in pre_computed_artifact));
      const hasVersion = VERSION_FIELDS.some((f) => f in pre_computed_artifact);
      if (missing.length > 0 || !hasVersion) {
        const problems = [...missing];
        if (!hasVersion) problems.push('one of: chaingraph_version | ap2_version');
        return {
          isError: true,
          content: [{ type: 'text', text: 'Artifact missing required ChainGraph Standard fields: ' + problems.join(', ') + '.' }],
        };
      }
      const pp = pre_computed_artifact.policy_parameters;
      const op = pre_computed_artifact.output_payload;
      const claimed = pre_computed_artifact.execution_hash ?? null;
      const computed_hash = await cgExecutionHash(pp, op);
      // Tolerate the optional "sha256:" prefix (OCG spec convention) on either side.
      const __normH = (h) => (h == null ? h : String(h).replace(/^sha256:/, ''));
      const hash_valid = claimed != null && __normH(computed_hash) === __normH(claimed);
      const out = {
        mode: 'pre_computed',
        schema_valid: true,
        hash_valid,
        computed_hash,
        claimed_hash: claimed,
        hash_mismatch: !hash_valid
          ? 'Recomputed hash does not match claimed execution_hash — artifact may be modified or was hashed with a different canonicalization.'
          : null,
        artifact: pre_computed_artifact,
        note: 'Pass artifact.execution_hash as parent_hashes when calling downstream ChainGraph tools. Use verify_execution_hash for independent verification.',
        spec: 'ChainGraph Standard v0.1 §4',
      };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
    }

    // --- Modes 2 & 3: tool_id required ---
    if (!tool_id) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Provide either pre_computed_artifact or tool_id. To list available ChainGraph tool_ids call build_chaingraph.' }],
      };
    }

    const node = cgById[tool_id];
    if (!node) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'Unknown tool_id "' + tool_id + '". Run build_chaingraph or inspect chaingraph.json for live node tool_ids.' }],
      };
    }

    const browser_url = node.url ?? (BASE_URL + '/chaingraph/' + tool_id + '.html');
    const gpu = !!node.gpu;
    const chain_block = {
      parent_hashes: parent_hashes ?? [],
      parent_tool_ids: parent_tool_ids ?? [],
      chain_depth: node.chain_depth ?? 0,
    };
    // v0.3.1: resolve the node's ISO 20022 profile token to its dereferenceable
    // dct:conformsTo URI (W3C Content Negotiation by Profile token->URI map).
    // Outside the execution_hash preimage — framing only.
    const OCG_PROFILE_URIS = {
      'iso20022:pacs.008-subset': 'https://ainumbers.co/chaingraph/profiles/iso20022/pacs008-subset.jsonld',
      'iso20022:party-identification': 'https://ainumbers.co/chaingraph/profiles/iso20022/party-identification.jsonld',
    };
    const profile_conforms_to = node.semantic_profile && OCG_PROFILE_URIS[node.semantic_profile]
      ? [OCG_PROFILE_URIS[node.semantic_profile]]
      : null;
    // @context: base context always; add the ISO 20022 overlay only when a profile applies.
    const envelope_context = profile_conforms_to ? [BASE_CONTEXT, ISO_CONTEXT] : BASE_CONTEXT;

    // --- Mode 3: tool_id only, no policy_parameters ---
    if (!policy_parameters) {
      const out = {
        mode: 'node_metadata',
        tool_id,
        title: node.display_name ?? node.title ?? tool_id,
        mandate_type: node.mandate_type,
        gpu,
        wave: node.wave,
        consumes: node.consumes ?? [],
        feeds: node.feeds ?? [],
        browser_url,
        semantic_profile: node.semantic_profile ?? null,
        artifact_schema: {
          '@context': envelope_context,
          chaingraph_version: CHAINGRAPH_VERSION,
          mandate_type: node.mandate_type,
          tool_id,
          tool_version: '1.0.0',
          chain: chain_block,
          ...(profile_conforms_to ? { 'dct:conformsTo': profile_conforms_to } : {}),
          note: 'Run the tool in the browser, export the Policy Mandate JSON, then call emit_chaingraph_artifact({ pre_computed_artifact: <json> }) to verify and receive a structured receipt.',
        },
        spec: 'ChainGraph Standard v0.1 §4',
      };
      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
    }

    // --- Mode 4: server-side kernel dispatch (v0.4 Compute Binding) ---
    // Conditions: policy_parameters provided AND compute != 'browser' AND node.gpu === false
    // AND a kernel is registered for this tool_id.
    const effectiveCompute = compute ?? 'auto';
    if (policy_parameters && effectiveCompute !== 'browser' && !gpu) {
      const kernel = getKernel(tool_id);
      if (kernel) {
        try {
          const now = new Date().toISOString();
          const artifact = await kernel.buildArtifact(policy_parameters, {
            now,
            parent_hashes: parent_hashes ?? [],
            parent_tool_ids: parent_tool_ids ?? [],
            chain_depth: node.chain_depth ?? 0,
          });
          // Verify the hash we just produced (round-trip self-check).
          const recomputed = await cgExecutionHash(artifact.policy_parameters, artifact.output_payload);
          const hash_valid = recomputed === artifact.execution_hash;
          // §17 — attach the node's published kernel-source identity (advisory: which SOURCE ran — NOT a
          // proof of execution, that is §18). Digest is the Graph Index sha256-source compute_image, which
          // equals sourceDigest() of the vendored kernel that just ran. Hash-excluded; no execution_hash change.
          {
            const srcImg = Array.isArray(node.compute_images) && node.compute_images.find((i) => i.system === 'sha256-source');
            if (srcImg && srcImg.image_id) {
              artifact.audit_signature = { ...(artifact.audit_signature || {}), build_identity: {
                kernel_digest: srcImg.image_id,
                buildType: 'https://ainumbers.co/chaingraph/context/v0.2#WebCryptoSHA256',
                source_ref: 'kernels/' + node.tool_id + '.kernel.mjs',
              } };
            }
          }
          // §18 — attach the node's offline compute-integrity receipt iff it is ABOUT this exact output
          // (journal.output JCS-equals the produced output_payload). Hash-excluded; never alters the
          // execution_hash. A mismatching input gets no proof (the receipt proves one specific output).
          if (node.compute_proof && node.compute_proof.journal
              && JSON.stringify(cgCanon(node.compute_proof.journal.output)) === JSON.stringify(cgCanon(artifact.output_payload))) {
            artifact.audit_signature = { ...(artifact.audit_signature || {}), compute_proof: node.compute_proof };
          }
          const out = {
            mode: 'server_compute',
            compute_mode: 'server',
            chaingraph_version: CHAINGRAPH_VERSION,
            tool_id,
            title: node.display_name ?? node.title ?? tool_id,
            mandate_type: node.mandate_type,
            gpu: false,
            browser_url,
            hash_valid,
            computed_hash: recomputed,
            artifact,
            note: 'Kernel computed server-side. execution_hash verified. Pass artifact.execution_hash as parent_hashes to downstream ChainGraph tools. Use verify_execution_hash for independent third-party verification.',
            spec: 'ChainGraph Standard v0.4 §3 Compute Binding',
          };
          return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Kernel compute error for "' + tool_id + '": ' + String(err?.message ?? err) }],
          };
        }
      }
      // No kernel registered — fall through to Mode 2 (browser delegation).
    }

    // --- Mode 2: tool_id + policy_parameters (browser delegation) ---
    const artifact_template = {
      '@context': envelope_context,
      chaingraph_version: CHAINGRAPH_VERSION,
      mandate_type: node.mandate_type,
      tool_id,
      tool_version: '1.0.0',
      generated_at: null,
      execution_hash: null,
      chain: chain_block,
      ...(profile_conforms_to ? { 'dct:conformsTo': profile_conforms_to } : {}),
      policy_parameters,
      output_payload: null,
      compliance_flags: [],
      audit_signature: null,
    };
    const prefill_url = browser_url + '#in=' + base64urlEncode(policy_parameters);
    const out = {
      mode: gpu ? 'browser_delegation_gpu' : 'browser_delegation',
      tool_id,
      title: node.display_name ?? node.title ?? tool_id,
      mandate_type: node.mandate_type,
      gpu,
      browser_url,
      prefill_url,
      artifact_template,
      next_steps: [
        '1. Open prefill_url in a browser (inputs pre-filled via AIN Bridge #in= fragment).',
        '2. Run the tool — all compute is client-side, zero egress.',
        '3. Click "Export Policy Mandate" to download the artifact JSON.',
        '4. Call emit_chaingraph_artifact({ pre_computed_artifact: <json> }) to validate schema and verify execution_hash.',
        '5. Pass artifact.execution_hash as parent_hashes to downstream ChainGraph tools.',
      ],
      reason: gpu
        ? 'GPU Monte-Carlo simulation — compute must remain client-side per ChainGraph Standard v0.1 §9.2. Return the Task handle or browser deep-link to the agent; do not move sim compute server-side.'
        : null,
      spec: 'ChainGraph Standard v0.1 §4',
    };
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], structuredContent: out };
  });

  // -------------------------------------------------------------------------
  // build_session_receipt (Workstream C — v0.4 Compute Binding)
  // Aggregates N execution_hashes from one agent session into a single
  // SHA-256 Merkle root. Returns a tamper-evident session receipt suitable
  // for EU AI Act Art. 12 / DORA audit trails, plus a PTG-01 regulator-framed prompt.
  // Mirrors CRY-05 kernel logic (no kernel dependency here — pure Worker compute).
  // -------------------------------------------------------------------------
  server.registerTool('build_session_receipt', {
    title: 'Build a session audit receipt (Merkle root)',
    description:
      'Aggregates execution_hashes from N ChainGraph tool calls in one agent session into a ' +
      'single SHA-256 Merkle root (session_receipt_root). Returns a tamper-evident session receipt ' +
      'and a regulator-framed PTG-01 audit prompt. ' +
      'One receipt covers an entire agent session: supply all execution_hashes in call order. ' +
      'The Merkle root is deterministic — the same hashes in the same order always produce the same root. ' +
      'Compliant with EU AI Act Art. 12 (transparency) and DORA ICT audit-trail requirements.',
    inputSchema: {
      execution_hashes: z.array(z.string()).describe(
        'Ordered list of execution_hash values from ChainGraph tool calls in this session (each produced by emit_chaingraph_artifact or a kernel tool). Minimum 1.'
      ),
      tool_ids: z.array(z.string()).optional().describe(
        'tool_id values corresponding to execution_hashes, in the same order. Used for the audit narrative.'
      ),
      session_id: z.string().optional().describe(
        'Optional agent session identifier for the audit narrative (e.g. a UUID or timestamp).'
      ),
      framing: z.string().optional().describe(
        'Optional framing context for the PTG-01 regulator prompt (e.g. "DORA incident review" or "EU AI Act Art.12 transparency log").'
      ),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ execution_hashes, tool_ids, session_id, framing }) => {
    if (!execution_hashes || execution_hashes.length === 0) {
      return { isError: true, content: [{ type: 'text', text: 'execution_hashes must be a non-empty array.' }] };
    }
    // Merkle tree: SHA-256 of concatenated hex strings (no prefix), binary tree, duplicate last leaf if odd.
    const normalize = (h) => String(h).replace(/^sha256:/, '').toLowerCase();
    const hashPair = async (a, b) => {
      const combined = normalize(a) + normalize(b);
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(combined));
      return 'sha256:' + [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
    };
    let level = execution_hashes.map(normalize).map((h) => 'sha256:' + h.replace(/^sha256:/, ''));
    while (level.length > 1) {
      const next = [];
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i];
        const right = level[i + 1] ?? level[i]; // duplicate last if odd
        next.push(await hashPair(left, right));
      }
      level = next;
    }
    const session_receipt_root = level[0];
    const generated_at = new Date().toISOString();
    const framingStr = framing ?? 'Agent session audit trail';
    const toolList = (tool_ids ?? []).map((id, i) => '  ' + (i + 1) + '. ' + id + ' → ' + execution_hashes[i]).join('\n');
    const ptg01_prompt =
      framingStr + '\n\n' +
      'Session receipt root (SHA-256 Merkle): ' + session_receipt_root + '\n' +
      'Generated at: ' + generated_at + '\n' +
      (session_id ? 'Session ID: ' + session_id + '\n' : '') +
      'Tools executed (' + execution_hashes.length + '):\n' +
      (toolList || execution_hashes.map((h, i) => '  ' + (i + 1) + '. ' + h).join('\n')) + '\n\n' +
      'This receipt covers ' + execution_hashes.length + ' verifiable ChainGraph tool call(s). ' +
      'Each execution_hash is independently verifiable via verify_execution_hash. ' +
      'The Merkle root proves the complete set of tool calls in this session has not been tampered with. ' +
      'Regulatory alignment: EU AI Act Art. 12 (transparency log); DORA ICT audit trail; ChainGraph Standard v0.4 §C (session receipt).';
    const receipt = {
      chaingraph_version: '0.4.0',
      receipt_type: 'session_receipt',
      session_receipt_root,
      hash_count: execution_hashes.length,
      execution_hashes,
      tool_ids: tool_ids ?? null,
      session_id: session_id ?? null,
      generated_at,
      framing: framingStr,
      merkle_algorithm: 'SHA-256 binary tree, duplicate-last-leaf padding',
      ptg01_prompt,
      spec: 'ChainGraph Standard v0.4 §C',
    };
    return { content: [{ type: 'text', text: JSON.stringify(receipt, null, 2) }], structuredContent: receipt };
  });

  // -------------------------------------------------------------------------
  // export_artifact -- chaingraph_export profiles (OCG Standard §13). 7th utility tool.
  // Renders a verified v0.4 artifact to xlsx / csv / pdf / xbrl, server-side, hash-excluded.
  // Per-node export_capability gate (additive: a node with no declared export_capability
  // still allows exports; flip the default to `false` once export_capability is back-filled
  // catalog-wide for hard §13.4 enforcement).
  // -------------------------------------------------------------------------
  const isFormatAllowed = (tool_id, format) => {
    const cap = cgById[tool_id]?.export_capability;
    if (!cap || !cap.length) return true;
    return cap.some((c) => c === format || c.startsWith(format + ':')); // e.g. 'xbrl:eba-corep-own-funds'
  };
  registerExportArtifact(server, z, { isFormatAllowed, fragmentLink });

  // -------------------------------------------------------------------------
  // Discovery layer — find_chain and find_tool (hot tools, never deferred).
  // Agents use these to locate recipes and node tools without enumerating the
  // full 150+ tool catalog. BM25 index precomputed in generate.mjs.
  // -------------------------------------------------------------------------

  server.registerTool('find_chain', {
    title: 'Find ChainGraph workflow chain',
    description:
      'BM25 search over all ' + (chaingraph?.chains?.length ?? 0) + ' AINumbers ChainGraph chains. ' +
      'Returns ranked chains with their full recipe: ordered node sequence, deep-links, composer URL, and entry tool mcp_name. ' +
      'Agent flow: find_chain(query) → read recipe → call the listed node MCP tools in order, passing parent_hashes between steps. ' +
      'Do NOT use prompts/list or resources for agent chain discovery — use this tool.',
    inputSchema: {
      query: z.string().describe('Natural-language or keyword search (e.g. "AML programme", "DORA ICT readiness", "MiCA CASP", "PQC migration", "Basel capital").'),
      top_n: z.number().min(1).max(20).optional().describe('Max results to return (default 5).'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ query, top_n }) => {
    const results = bm25Search(query, searchIndex.chains, { topN: top_n ?? 5 });
    if (!results.length) {
      return {
        content: [{ type: 'text', text: 'No chains matched "' + query + '". Try broader terms or call list_ainumbers_tools for individual tool search.' }],
        structuredContent: { query, results: [], hint: 'No matches. Try list_ainumbers_tools for individual tools or find_tool for node-level search.' },
      };
    }
    const out = results.map(({ _score, ...r }) => ({ ...r, relevance_score: Math.round(_score * 1000) / 1000 }));
    return {
      content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
      structuredContent: {
        query,
        result_count: out.length,
        chains: out,
        usage: 'For each step in order: if callable=true, invoke its mcp_name via /mcp; if callable=false it is a browser tool — open tool_url. Pass execution_hash from each callable step as parent_hashes to the next. Verify any artifact with verify_execution_hash. entry_mcp_name is the first callable node.',
      },
    };
  });

  server.registerTool('find_tool', {
    title: 'Find ChainGraph node tool',
    description:
      'BM25 search over all ' + (chaingraph?.nodes?.filter(n => n.status === 'live').length ?? 0) + ' live AINumbers ChainGraph node tools. ' +
      'Returns ranked tools with mcp_name, URL, mandate type, and wave. ' +
      'Use to locate a specific computation node (e.g. "FRTB expected shortfall", "MiCA own funds", "XVA calculator") ' +
      'before calling it. Complements find_chain (chain-level) and list_ainumbers_tools (catalog-level).',
    inputSchema: {
      query: z.string().describe('Natural-language or keyword search (e.g. "FRTB", "XVA", "MiCA own funds", "AML risk rating", "stress test").'),
      top_n: z.number().min(1).max(20).optional().describe('Max results to return (default 5).'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, ({ query, top_n }) => {
    const results = bm25Search(query, searchIndex.nodes, { topN: top_n ?? 5 });
    if (!results.length) {
      return {
        content: [{ type: 'text', text: 'No node tools matched "' + query + '". Try find_chain for workflow-level search or list_ainumbers_tools for the full catalog.' }],
        structuredContent: { query, results: [], hint: 'No matches — try find_chain or list_ainumbers_tools.' },
      };
    }
    const out = results.map(({ _score, ...r }) => ({ ...r, relevance_score: Math.round(_score * 1000) / 1000 }));
    return {
      content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
      structuredContent: { query, result_count: out.length, tools: out },
    };
  });

  // -------------------------------------------------------------------------
  // MCP Prompts — curated human slash-commands (~12 flagship journeys).
  // Chains are agent-reachable via find_chain; these Prompts are for human /slash use.
  // (The 283 auto-derived chain Prompts were removed — they were agent-invisible anyway
  // per MCP spec and bloated prompts/list. find_chain replaces them for agents.)
  // Each prompt returns a structured step-by-step workflow message so any MCP
  // client can walk a user through a complete AINumbers chain end-to-end.
  // Zero server-side execution -- browser tools remain the deterministic layer.
  // -------------------------------------------------------------------------

  // Prompt registration wrapper: dedupe by name so a hand-authored prompt and an auto-derived one
  // can never collide (a duplicate prompt name would 500 the /mcp handshake). First-registered wins —
  // the rich hand-authored prompts below run before the auto-derive loop, so they override.
  const _promptNames = new Set();
  const regPrompt = (name, cfg, handler) => {
    if (_promptNames.has(name)) return;
    _promptNames.add(name);
    server.registerPrompt(name, cfg, handler);
  };

  regPrompt('aml_programme_workflow', {
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


  regPrompt('dora_readiness_workflow', {
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

  regPrompt('pi_emi_authorisation_workflow', {
    title: 'PI/EMI Authorisation — PSD2/PSRs Workflow',
    description: 'Walk a UK/EU fintech through the PI/EMI authorisation chain: FCA/EBA authorisation readiness, EMI capital requirements, PI own funds, PSP safeguarding, and PSR APP reimbursement liability.',
    argsSchema: {},
  }, async () => {
    return {
      description: 'PI/EMI Authorisation PSD2/PSRs workflow -- T404 > T405 > T418 > T269 > T406, composite Policy Mandate export.',
      messages: [{ role: 'user', content: { type: 'text', text:
        'You are helping a UK/EU fintech or payments startup through FCA Payment Institution or E-Money Institution authorisation using AINumbers deterministic tools. ' +
        'All tools run client-side -- zero PII, zero network. Use synthetic or anonymised firm data only.\n\n' +
        'Step 1 -- Build workflow links: call `build_workflow_links` with chain "pi-emi-authorisation". Returns the ordered deep-link set (T404 > T405 > T418 > T269 > T406) and the composer URL.\n\n' +
        'Step 2 -- Orchestrated run: open the PI/EMI Authorisation Composer at ' + BASE_URL + '/guides/pi-emi-authorisation-composer.html. ' +
        'Stage 1 (T404) assesses PI authorisation readiness against PSRs 2017 Schedule 2: programme of operations, safeguarding, governance, and risk management gaps. ' +
        'Stage 2 (T405) calculates EMI initial capital (EUR 350,000 full / EUR 50,000 small) and ongoing own funds under EMD2 Methods A, B, and C. ' +
        'Stage 3 (T418) calculates PI own funds requirements under PSD2 Article 9 / PSRs 2017; the higher of Methods A, B, and C applies at all times. ' +
        'Stage 4 (T269) assesses PSP customer fund safeguarding: segregation method vs. insurance/guarantee method; identifies shortfalls and FCA monitoring gaps. ' +
        'Stage 5 (T406) models PSR Mandatory APP reimbursement liability (effective 7 Oct 2024): Sending PSP / Receiving PSP 50/50 split up to GBP 85,000 per claim. Mandate type: compliance_control.\n\n' +
        'Authorisation timeline note: FCA PI authorisation typically takes 3-6 months from complete application. Critical gaps from Stage 1 must be remediated before submission. ' +
        'Safeguarding arrangements (Stage 4) must be live before any customer funds are received.\n\n' +
        'After the run: present the composite Policy Mandate JSON as the PI/EMI authorisation readiness record. Re-run annually or on any material change to business model, payment volumes, or authorisation scope.',
      }}],
    };
  });

  regPrompt('crypto_tax_reporting_workflow', {
    title: 'Crypto-Asset Tax Reporting Workflow (CARF / DAC8 / 1099-DA)',
    description: 'Walk a CASP or tax team through end-to-end crypto-asset tax reporting: CARF/DAC8 reportable classification, cost-basis and gain/loss calculation, IRS Form 1099-DA assembly, and CASP readiness scoring. Covers OECD CARF (52 jurisdictions, effective 1 Jan 2026), EU DAC8 (FY2026, first reports 31 Jan 2027), and US TD 9996 1099-DA (gross proceeds from 1 Jan 2025, basis from 1 Jan 2026). ⚠ US-CARF exchange not effective until 2027.',
    argsSchema: {
      entity_type:    z.string().optional().describe('Type of entity (e.g. CEX, DEX, custodian, brokerage, CASP). Scopes reportable obligations.'),
      jurisdiction:   z.string().optional().describe('Primary jurisdiction(s) (e.g. EU, UK, US, OECD). Determines which frameworks apply.'),
      tax_year:       z.string().optional().describe('Tax year under review (e.g. 2025, 2026). Affects 1099-DA good-faith relief and SBIE transitional rates.'),
    },
  }, async ({ entity_type, jurisdiction, tax_year }) => {
    const scope = [entity_type, jurisdiction, tax_year ? 'FY' + tax_year : null].filter(Boolean).join(', ');
    return {
      description: 'Crypto-asset tax reporting workflow: T465 CARF/DAC8 classifier > T466 cost-basis calc > T467 Form 1099-DA generator > T468 CASP readiness scorer.',
      messages: [{ role: 'user', content: { type: 'text', text:
        'Walk me through end-to-end crypto-asset tax reporting' + (scope ? ' for ' + scope : '') + ' using AINumbers tools.\n\n' +
        'Step 1 — CARF/DAC8 Reportable Classifier (T465): open https://ainumbers.co/tools/465-carf-dac8-reportable-classifier.html. ' +
        'Classify each user and transaction as reportable or not under OECD CARF and EU DAC8. ' +
        'CARF applies in 52 jurisdictions from 1 Jan 2026. DAC8: EU FY2026, first reports 31 Jan 2027. ' +
        'Export the classification Policy Mandate before proceeding.\n\n' +
        'Step 2 — Crypto Cost-Basis & Gain/Loss Calculator (T466): open https://ainumbers.co/tools/466-crypto-cost-basis-gain-calculator.html. ' +
        'Compute cost basis (FIFO, LIFO, specific ID) and short/long-term gain/loss per IRC §1222 for each reportable disposal. ' +
        'Rev. Proc. 2024-28 per-wallet basis tracking applies from 2025. ' +
        'Export the gain/loss schedule Policy Mandate.\n\n' +
        'Step 3 — Form 1099-DA Generator (T467): open https://ainumbers.co/tools/467-form-1099-da-generator.html. ' +
        'Assemble IRS Form 1099-DA records (Box 1a–1e, Box 2 term, Box 3 asset identifier) per TD 9996. ' +
        'Good-faith transitional penalty relief applies for 2025 (IRS Notice 2025-7). ' +
        'Export filing-ready CSV and Policy Mandate.\n\n' +
        'Step 4 — CASP Tax Reporting Readiness Scorer (T468): open https://ainumbers.co/tools/468-casp-tax-reporting-readiness-scorer.html. ' +
        'Score readiness across 5 domains: due diligence & customer ID, data completeness, technical infrastructure, governance, and US compliance. ' +
        'Export the readiness scorecard Policy Mandate.\n\n' +
        'Or open the composer for a single-page orchestrated run: https://ainumbers.co/guides/crypto-tax-reporting-composer.html\n\n' +
        'After all stages: export the composite Policy Mandate and present a gap-priority remediation list.',
      }}],
    };
  });

  regPrompt('bank_capital_liquidity_workflow', {
    title: 'Bank Capital & Liquidity (Basel III) Workflow',
    description: 'Walk a bank treasury or capital team through the full Basel III capital and liquidity stack: RWA calculation, LCR, NSFR, leverage ratio, and Pillar 3 disclosure assembly. Covers BCBS 189 (capital), 238 (LCR), 295 (NSFR), 270/360 (leverage), 309/400 (Pillar 3).',
    argsSchema: {
      bank_type:      z.string().optional().describe('Type of institution (e.g. G-SIB, national bank, regional bank, branch). Affects G-SIB surcharge and buffer levels.'),
      jurisdiction:   z.string().optional().describe('Regulatory jurisdiction (e.g. EU CRR3, UK PRA, US Fed). Scopes applicable calibrations.'),
      period:         z.string().optional().describe('Reporting period (e.g. Q1 2026, FY2025). Used for Pillar 3 disclosure header.'),
    },
  }, async ({ bank_type, jurisdiction, period }) => {
    const scope = [bank_type, jurisdiction, period].filter(Boolean).join(', ');
    return {
      description: 'Basel III capital and liquidity workflow: T201 RWA > T469 LCR > T470 NSFR > T471 leverage ratio > T472 Pillar 3 disclosure.',
      messages: [{ role: 'user', content: { type: 'text', text:
        'Walk me through the full Basel III capital and liquidity workflow' + (scope ? ' for ' + scope : '') + ' using AINumbers tools.\n\n' +
        'Step 1 — Basel RWA Calculator (T201): open https://ainumbers.co/tools/201-basel-rwa-calculator.html. ' +
        'Compute credit, market, and operational risk RWA per BCBS 189. Outputs total RWA, CET1/T1/TC ratios, and capital requirements. ' +
        'Export Policy Mandate before proceeding.\n\n' +
        'Step 2 — LCR Calculator (T469): open https://ainumbers.co/tools/469-lcr-calculator.html. ' +
        'Build HQLA buffer (L1/L2A/L2B with cap logic) and net cash outflows per BCBS 238. LCR ≥ 100% required. ' +
        'Export Policy Mandate.\n\n' +
        'Step 3 — NSFR Calculator (T470): open https://ainumbers.co/tools/470-nsfr-calculator.html. ' +
        'Calculate Available Stable Funding (ASF) and Required Stable Funding (RSF) per BCBS 295. NSFR ≥ 100% required. ' +
        'Export Policy Mandate.\n\n' +
        'Step 4 — Leverage Ratio Calculator (T471): open https://ainumbers.co/tools/471-leverage-ratio-calculator.html. ' +
        'Compute Tier 1 / Total Exposure ≥ 3% per BCBS 360. G-SIB buffer = 50% of G-SIB surcharge. ' +
        'Export Policy Mandate.\n\n' +
        'Step 5 — Pillar 3 Disclosure Builder (T472): open https://ainumbers.co/tools/472-pillar-3-disclosure-builder.html. ' +
        'Assemble KM1, OV1, LIQ1, LIQ2 tables per BCBS 309/400 from the outputs of Steps 1–4. ' +
        'Verify row definitions against EBA ITS (EU) or PRA rules (UK) before use in actual disclosures. ' +
        'Export composite Policy Mandate.\n\n' +
        'Or open the composer: https://ainumbers.co/guides/bank-capital-liquidity-composer.html\n\n' +
        'After all stages: export the composite Policy Mandate for the capital and liquidity regulatory reporting record.',
      }}],
    };
  });

  regPrompt('pillar_two_globe_workflow', {
    title: 'Pillar Two GloBE Minimum Tax Workflow',
    description: 'Walk a tax team through the OECD Pillar Two GloBE end-to-end workflow: effective tax rate by jurisdiction, top-up tax and QDMTT/IIR/UTPR allocation, transitional safe harbour eligibility, and GloBE Information Return (GIR) assembly. 15% global minimum ETR. ⚠ CRITICAL: US-headquartered MNE groups are EXEMPT from IIR and UTPR per the OECD January 2026 side-by-side package. Do NOT apply IIR/UTPR to US-parented groups. QDMTT exposure applies to all groups. First GIR filings due 30 June 2026.',
    argsSchema: {
      parent_hq:      z.string().optional().describe('Parent HQ jurisdiction ISO-3 (e.g. DE, GB, JP, US). If US, IIR/UTPR exemption applies.'),
      fy:             z.string().optional().describe('Fiscal year under analysis (e.g. 2024, 2025, 2026).'),
      revenue_scope:  z.string().optional().describe('Estimated consolidated revenue in €m (to confirm ≥ €750M GloBE scope).'),
    },
  }, async ({ parent_hq, fy, revenue_scope }) => {
    const us_hq = (parent_hq || '').toUpperCase() === 'US';
    const scope = [parent_hq ? 'HQ: ' + parent_hq.toUpperCase() : null, fy ? 'FY' + fy : null, revenue_scope ? '€' + revenue_scope + 'm revenue' : null].filter(Boolean).join(', ');
    return {
      description: 'Pillar Two GloBE workflow: T473 ETR by jurisdiction > T474 top-up tax/QDMTT > T475 safe harbours > T476 GIR Builder.',
      messages: [{ role: 'user', content: { type: 'text', text:
        '⚠ CRITICAL US EXEMPTION: US-headquartered MNE groups are EXEMPT from IIR (Income Inclusion Rule) and UTPR (Under-Taxed Profits Rule) per the OECD January 2026 side-by-side package.' + (us_hq ? ' This group is US-headquartered — do NOT compute IIR or UTPR charges.' : '') + ' QDMTT exposure remains for all groups in GloBE-implementing jurisdictions.\n\n' +
        'Walk me through the Pillar Two GloBE minimum tax workflow' + (scope ? ' for ' + scope : '') + ' using AINumbers tools.\n\n' +
        'Step 1 — GloBE ETR Jurisdiction Calculator (T473): open https://ainumbers.co/tools/473-globe-etr-jurisdiction-calculator.html. ' +
        'Calculate GloBE ETR = Adjusted Covered Taxes / GloBE Income per Art. 5.1.1 for each jurisdiction. ' +
        'Apply SBIE deduction (transitional rates: FY2026 = 9.4% payroll + 5% assets per Art. 9.1). ' +
        'Minimum rate: 15% (Art. 5.2.4). Identify jurisdictions below 15% for top-up tax. ' +
        'Export Policy Mandate.\n\n' +
        'Step 2 — Top-up Tax / QDMTT Calculator (T474): open https://ainumbers.co/tools/474-topup-tax-qdmtt-calculator.html. ' +
        'Top-up tax = (15% − ETR) × GloBE income net SBIE (Art. 5.2.1). ' +
        'Allocate across QDMTT (Art. 11.3 — local collection, credited against IIR), IIR (Art. 2.1 — parent), UTPR (Art. 2.4 — backstop). ' +
        (us_hq ? '⚠ Set parent_hq = US — IIR and UTPR boxes will show EXEMPT. ' : '') +
        'Export Policy Mandate.\n\n' +
        'Step 3 — Safe Harbour Checker (T475): open https://ainumbers.co/tools/475-pillar-two-safe-harbour-checker.html. ' +
        'Three transitional CbCR tests (OECD agreed guidance, December 2022, available FY2024–FY2026): ' +
        '(1) de minimis — revenue < €10M AND PBT < €1M; ' +
        '(2) simplified ETR — CbCR taxes/PBT ≥ 16% (FY2026); ' +
        '(3) routine profits — CbCR PBT ≤ SBIE. ' +
        'Permanent safe harbour: GloBE ETR ≥ 15%. ' +
        '⚠ Safe harbour does not eliminate GIR disclosure obligation. ' +
        'Export Policy Mandate.\n\n' +
        'Step 4 — GloBE Information Return Builder (T476): open https://ainumbers.co/tools/476-gir-builder.html. ' +
        'Assemble GIR skeleton (Parts I, II, V) per OECD GIR Standard (November 2022). ' +
        'Required for groups with consolidated revenue ≥ €750M. ' +
        'First filing: FY2024 groups due 30 June 2026 (18-month transitional period). ' +
        (us_hq ? '⚠ Mark US jurisdictions as IIR/UTPR exempt. Verify local GIR filing obligations. ' : '') +
        'Actual XML filing requires authorised local tax software. ' +
        'Export composite Policy Mandate.\n\n' +
        'Or open the composer for a single-page orchestrated run: https://ainumbers.co/guides/pillar-two-globe-composer.html\n\n' +
        'After all stages: export the composite GloBE Policy Mandate and review for any jurisdictions requiring top-up tax remediation. ' +
        '⚠ Consult a qualified tax adviser before any real filing. Verify current OECD guidance at oecd.org/en/topics/sub-issues/global-minimum-tax/',
      }}],
    };
  });

  regPrompt('mcp_server_audit_workflow', {
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

  regPrompt('amlr_single_rulebook_workflow', {
    title: 'EU AML Single Rulebook (AMLR) Workflow',
    description: 'Walk an EU obliged entity through AMLR scope, UBO mapping, cash/EDD classification, CDD policy, and readiness. AMLR applies 10 Jul 2027.',
    argsSchema: {},
  }, () => ({
    messages: [{ role: 'user', content: { type: 'text', text:
      'You are helping an EU obliged entity prepare for the AMLR (Regulation (EU) 2024/1624, EU AML Single Rulebook, applies 10 Jul 2027; football-club provisions 2029) using AINumbers deterministic tools. ' +
      'Step 1 -- amlr-obliged-entity-scope-mapper: https://ainumbers.co/tools/485-amlr-obliged-entity-scope-mapper.html ' +
      'Step 2 -- amlr-ubo-beneficial-ownership-mapper: https://ainumbers.co/tools/486-amlr-ubo-beneficial-ownership-mapper.html ' +
      'Step 3 -- amlr-cash-limit-edd-classifier: https://ainumbers.co/tools/487-amlr-cash-limit-edd-classifier.html ' +
      'Step 4 -- amlr-cdd-policy-builder: https://ainumbers.co/tools/488-amlr-cdd-policy-builder.html ' +
      'Step 5 -- amla-2027-readiness-gap-analyzer (T350): https://ainumbers.co/tools/350-amla-2027-readiness-gap-analyzer.html ' +
      'Then call build_workflow_links with chain "amlr-single-rulebook" and present the composer URL. Synthetic data only -- never real customer PII.'
    } }],
  }));

  regPrompt('agent_commerce_conformance_workflow', {
    title: 'Agent Commerce Cross-Protocol Conformance Workflow',
    description: 'Walk an agent commerce implementer through AP2 v0.2 mandate chain validation, ACP checkout conformance, x402 settlement modelling, and unified cross-protocol conformance. Issues a single execution_hash receipt (H4) covering AP2 + ACP + Visa TAP RFC 9421 + x402. ChainGraph Standard v0.1.',
    argsSchema: {
      protocol_stack: z.string().optional().describe('Protocol stack in use (e.g. "AP2+ACP+x402", "AP2+Visa TAP", "ACP only"). Scopes conformance checks.'),
      entity_type:    z.string().optional().describe('Entity type (e.g. merchant, payment agent, wallet provider, acquirer). Scopes AP2 mandate type.'),
    },
  }, async ({ protocol_stack, entity_type }) => {
    const scope = [entity_type, protocol_stack].filter(Boolean).join(' · ');
    return {
      description: 'Agent Commerce Conformance: ART-01 → ART-12 → ART-03 → ART-30. Single execution_hash (H4) covers AP2 + ACP + TAP + x402.',
      messages: [{ role: 'user', content: { type: 'text', text:
        'Walk me through the Agent Commerce Cross-Protocol Conformance workflow' + (scope ? ' for ' + scope : '') + ' using AINumbers ChainGraph tools. ' +
        'This chain validates one agent purchase end-to-end across the converged agentic commerce stack: ' +
        'AP2 v0.2 Intent→Cart→Payment (FIDO Alliance, 60+ orgs) + ACP CheckoutRequest/Response (OpenAI/Stripe) + Visa TAP RFC 9421 HTTP Message Signature + x402 settlement leg (Coinbase CDP, ~69k agents, 165M+ txns 2026). ' +
        'All ChainGraph tools run client-side — zero PII, zero egress. Use synthetic transaction payloads only.\n\n' +
        'Step 1 — AP2 Mandate Chain Validator (ART-01): open https://ainumbers.co/chaingraph/art-01-ap2-mandate-chain-validator.html. ' +
        'Validate the AP2 v0.2 Intent→Cart→Payment mandate trio. ' +
        'Export the AP2 artifact JSON (execution_hash = H1). Or call validate_ap2_mandate_chain via MCP.\n\n' +
        'Step 2 — ACP Checkout Conformance Validator (ART-12): open https://ainumbers.co/chaingraph/art-12-acp-checkout-conformance-validator.html. ' +
        'Validate ACP CheckoutRequest/Response structure and Shared Payment Token. ' +
        'Set chain.parent_hashes = [H1]. Export artifact (execution_hash = H2). Or call validate_acp_checkout via MCP.\n\n' +
        'Step 3 — x402 Settlement Modeler (ART-03): open https://ainumbers.co/chaingraph/art-03-x402-settlement-modeler.html. ' +
        'Model the x402 HTTP 402-based settlement leg. ' +
        'Set chain.parent_hashes = [H2]. Export artifact (execution_hash = H3). Or call model_x402_settlement via MCP.\n\n' +
        'Step 4 — Agent Commerce Cross-Protocol Conformance Validator (ART-30): open https://ainumbers.co/chaingraph/art-30-agent-commerce-conformance-validator.html. ' +
        'Runs AP2 + ACP + Visa TAP RFC 9421 HTTP Message Signature + x402 in one unified validator. ' +
        'Set chain.parent_hashes = [H1, H2, H3]. ' +
        'Emits one execution_hash receipt (H4) covering the full transaction. Download cross-protocol test-vector fixtures.\n\n' +
        'After Step 4: call emit_chaingraph_artifact({ pre_computed_artifact: <H4 json> }) to verify the hash and receive the structured ChainGraph receipt. ' +
        'Then call build_chaingraph with chain "agent-commerce-conformance" to inspect the full DAG with parent_hash_slots.\n\n' +
        'Or open the chain page for the full orchestrated walkthrough: https://ainumbers.co/chaingraph/chains/agent-commerce-conformance.html\n\n' +
        '⚑ PROTOCOL SOURCES (2026-06-14 sweep): AP2 v0.2 — ap2-protocol.org · ACP — OpenAI/Stripe (agentic commerce protocol) · Visa TAP — RFC 9421 HTTP Message Signatures · x402 — x402.org (Coinbase CDP). ' +
        'These protocols are converging but are distinct standards — validate against each official spec before implementing. ' +
        'Synthetic payloads only — never real card, account, or payment credentials.',
      }}],
    };
  });

  regPrompt('pqc_migration_workflow', {
    title: 'Post-Quantum Cryptography Migration Workflow',
    description: 'End-to-end PQC migration: classify cryptographic assets (NISTIR 8547) > score HNDL quantum risk > build phased migration roadmap (FIPS 203/204/205) > score crypto-agility readiness. RSA/ECDSA/ECDH/DH deprecated 2030, disallowed 2035; DSA already disallowed. CRQC horizon ~2035.',
    argsSchema: {
      org_type:   z.string().optional().describe('Type of institution (e.g. bank, payment processor, asset manager, central bank). Scopes algorithm use cases.'),
      urgency:    z.string().optional().describe('Migration urgency (e.g. immediate -- HNDL-sensitive data at rest, planned -- standard lifecycle). Guides phase 1 prioritisation.'),
    },
  }, async ({ org_type, urgency }) => {
    const scope = [org_type, urgency].filter(Boolean).join(', ');
    return {
      description: 'PQC migration workflow: T499 crypto inventory > T500 HNDL risk scorer > T501 migration roadmap > T502 crypto-agility readiness.',
      messages: [{ role: 'user', content: { type: 'text', text:
        'Walk me through a complete Post-Quantum Cryptography migration workflow' + (scope ? ' for ' + scope : '') + ' using AINumbers deterministic tools. ' +
        'Standards: NISTIR 8547 · FIPS 203 (ML-KEM / Kyber) · FIPS 204 (ML-DSA / Dilithium) · FIPS 205 (SLH-DSA / SPHINCS+). ' +
        'All tools run client-side -- zero PII, zero network. Use synthetic or anonymised cryptographic inventory data only.\n\n' +
        'Step 1 — Crypto Asset Inventory Classifier (T499): open https://ainumbers.co/tools/499-crypto-asset-inventory-classifier.html. ' +
        'Classify each cryptographic asset by algorithm, use case, key length, and shelf life. ' +
        'Status taxonomy: QUANTUM_SAFE (ML-KEM/ML-DSA/SLH-DSA/SHA-3/AES-256) · DEPRECATED (RSA/ECDSA/ECDH/DH — disallowed 2035) · DISALLOWED (DSA — already disallowed) · UPGRADE_REC · COND_SAFE · REVIEW_REQUIRED. ' +
        'Flags HNDL-risk assets (Harvest-Now-Decrypt-Later). Satisfies PCI-DSS 12.3.3 cryptographic algorithm inventory step. ' +
        'Export the crypto_inventory Policy Mandate before proceeding.\n\n' +
        'Step 2 — HNDL Quantum Risk Scorer (T500): open https://ainumbers.co/tools/500-hndl-quantum-risk-scorer.html. ' +
        'Score each system\'s HNDL exposure: sensitivity × algorithm weight × time_exposure (shelf_life / CRQC_horizon) × internet/HVT multiplier. ' +
        'Risk tiers: CRITICAL (≥80) / HIGH (≥60) / MEDIUM (≥35) / LOW (≥10) / NEGLIGIBLE (<10). ' +
        'Phase mapping: CRITICAL → immediate (pre-2027), HIGH → within_2_years (2027-28), MEDIUM → within_5_years (2029-30), LOW → post_2030, NEGLIGIBLE → monitor. ' +
        'Default CRQC horizon: 2035. AIN Bridge accepts T499 mandate to auto-populate systems. ' +
        'Export the risk_assessment Policy Mandate.\n\n' +
        'Step 3 — PQC Migration Roadmap Builder (T501): open https://ainumbers.co/tools/501-pqc-migration-roadmap-builder.html. ' +
        'Map each system to its FIPS replacement by use case: key_exchange/TLS → ML-KEM (FIPS 203) · signature/certificate → ML-DSA (FIPS 204) + SLH-DSA backup (FIPS 205) · symmetric → AES-256 · hash/MAC → SHA-384/512. ' +
        'Enable hybrid mode (classical + PQC) for transition safety. Target Security Category 3 (192-bit quantum security) unless constraints require Cat 1 or 5. ' +
        'Assigns Phase 1–4 windows and flags vendor and library gaps. AIN Bridge accepts T500 mandate. ' +
        'Export the migration_plan Policy Mandate.\n\n' +
        'Step 4 — Crypto-Agility Readiness Scorer (T502): open https://ainumbers.co/tools/502-crypto-agility-readiness-scorer.html. ' +
        'Self-assess across 8 control dimensions (0–5 each, 40 max): inventory · tooling · policy · testing · vendor · governance · monitoring · incident response. ' +
        'Maturity levels: Level 1 (<8) to Level 5 (≥32). Regulated institutions should target Level 4 (≥24/40) before Q4 2026. ' +
        'Export the compliance_control Policy Mandate.\n\n' +
        'Or open the composer for a single-page orchestrated run: https://ainumbers.co/guides/pqc-migration-composer.html\n\n' +
        '⚠ ALGORITHM DEPRECATION TIMELINE: DSA — DISALLOWED now · RSA/ECDSA/ECDH/DH — DEPRECATED (disallowed 2035) · Phase 1 migration window closes pre-2027 for HNDL-critical systems.\n\n' +
        'After all stages: export the composite Policy Mandate and present priority gaps, Phase 1 system list, and recommended engagement cadence with vendors. Re-run quarterly.',
      }}],
    };
  });

  // Wave 8 prompts

  regPrompt('canton_capital_efficiency_workflow', {
    title: 'Canton Capital Efficiency Workflow',
    description: 'Guide for assessing Canton Network pilot readiness and computing settlement-risk capital savings. Runs T503 readiness diagnostic → T504 capital optimizer → Basel 3.1 RWA → XVA/CVA → LCR/NSFR chain.',
    argsSchema: {
      entity_type: z.string().optional().describe('Entity type (g_sib/regional_bank/broker_dealer/asset_manager)'),
    },
  }, async ({ entity_type }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text:
          'Run the Canton Capital Efficiency Chain for a ' + (entity_type || 'financial institution') + '.\n\n' +
          'Step 1 — Canton Tokenization Readiness Diagnostic (T503): open https://ainumbers.co/tools/503-canton-tokenization-readiness-diagnostic.html. ' +
          'Answer 12 weighted questions across 6 domains: settlement ops, custody, cash-leg, privacy, AML/KYA, and capital readiness. ' +
          'The diagnostic grades A–F per domain and routes to the correct Canton chain based on gaps. Export the readiness_diagnostic Policy Mandate.\n\n' +
          'Step 2 — Settlement-Risk Capital Efficiency Optimizer (T504): open https://ainumbers.co/tools/504-settlement-risk-capital-optimizer.html. ' +
          'Feed the T503 readiness mandate (entity_type, grade, gaps). Compute RWA delta and annual capital saving in bps-of-notional from atomic DvP elimination of settlement risk. ' +
          'Regulatory basis: BCBS CRE70 (settlement risk capital); CRE52 (SA-CCR netting). Export the capital_assessment Policy Mandate.\n\n' +
          'Step 3 — Feed the capital delta to the Basel 3.1 RWA, XVA/CVA, and LCR/NSFR tools for the full regulatory picture. ' +
          'Use compute_rwa_scenarios for Basel 3.1 RWA impact, compute_options_greeks / calculate_xva for CVA/XVA, and run_liquidity_stress_test for LCR/NSFR.\n\n' +
          'Chain composer: https://ainumbers.co/guides/canton-capital-efficiency-composer.html\n\n' +
          'All tools run client-side — zero PII, zero network. Use synthetic or anonymised data only. ' +
          'Export a Policy Mandate at each stage and chain execution_hashes for a full audit trail.',
      },
    }],
  }));

  // -------------------------------------------------------------------------
  // ChainGraph Suite -- one MCP tool per live node in chaingraph.json
  // All simulation runs in-browser; the tool returns the URL + structured
  // metadata so an agent can navigate, run, and chain AP2 artifacts.
  // Source of truth: repo/chaingraph/chaingraph.json (vendored into data/).
  // -------------------------------------------------------------------------
  // Guard against duplicate mcp_name registrations (would throw and abort buildServer).
  // Canonical fix is unique mcp_names in chaingraph.json; this is a belt-and-suspenders
  // safety net so a future collision degrades gracefully instead of taking the server down.
  // Seed with names ALREADY registered above — the PILOT widget tools (registerAppTool)
  // and the utility tools — not just node-vs-node. A ChainGraph node whose mcp_name
  // duplicates one of those is the SAME logical tool (e.g. pilot 276 / node art-22 both
  // = compare_agentic_payment_protocols; pilot 285 / art-21 = build_google_ap2_mandate;
  // 277/art-26, 283/art-25, 286/art-23). Registering it twice throws "Tool X is already
  // registered" and took the whole /mcp handshake down (2026-06-19). Skip, don't throw.
  const _registeredMcpNames = new Set([
    ...PILOT.map((slug) => manifests[slug]?.mcp_tool_definition?.name ?? slug.replace(/-/g, '_')),
    'list_ainumbers_tools', 'build_workflow_links', 'verify_execution_hash',
    'build_chaingraph', 'emit_chaingraph_artifact', 'build_session_receipt',
    'find_chain', 'find_tool', 'run_chain',
  ]);

  for (const node of (chaingraph?.nodes ?? [])) {
    if (node.status !== 'live') continue;
    const toolName = node.mcp_name;
    if (!toolName || _registeredMcpNames.has(toolName)) continue;
    _registeredMcpNames.add(toolName);
    // O(1) single-tool build: when a specific tool is requested, skip CONSTRUCTING every other
    // node's zod schema + description + closure (the stub at the top only no-ops the SDK
    // registerTool *call* — the loop body still ran for all ~174 nodes, which is the residual
    // cold-isolate CPU that trips the Free-plan 1102 under bursty tools/call). The dedup .add above
    // still runs so duplicate-mcp_name protection is unchanged. Full build (onlyTool null) is
    // untouched. Verified byte-identical to the full build per requested tool (build-mcp-parity).
    if (onlyTool && toolName !== onlyTool) continue;
    const consumes = node.consumes ?? [];
    const feeds = node.feeds ?? [];
    const deadlineNote = node.deadline ? ' Regulatory deadline: ' + node.deadline + (node.deadline_note ? ' (' + node.deadline_note + ').' : '.') : '';
    server.registerTool(toolName, {
      title: node.display_name,
      description:
        node.display_name + ': OpenChainGraph compute node (' + node.mandate_type + ').' + deadlineNote +
        ' Runs deterministically in-browser; zero PII, zero egress. Exports an AP2 artifact with execution_hash for chain provenance.' +
        (consumes.length ? ' Consumes upstream artifacts from: ' + consumes.join(', ') + '.' : '') +
        (feeds.length   ? ' Output feeds: ' + feeds.join(', ') + '.' : '') +
        ' Open at: ' + node.url,
      inputSchema: {
        policy_parameters: z.record(z.any()).optional()
          .describe('Input parameters for this tool\'s decision function. For gpu:false nodes with a registered kernel, these are computed server-side when compute is "auto" or "server". See the tool\'s manifest for field names.'),
        compute: z.enum(['auto', 'server', 'browser']).optional()
          .describe('Compute mode (v0.4 Compute Binding). "auto" (default) = server for gpu:false nodes with registered kernels; "server" = force server-side; "browser" = always return browser delegation URL. gpu:true nodes always delegate.'),
        parent_hashes: z.array(z.string()).optional()
          .describe('execution_hash values from upstream ChainGraph AP2 artifacts to chain from (sets chain.parent_hashes in the export).'),
        parent_tool_ids: z.array(z.string()).optional()
          .describe('tool_id values matching parent_hashes, in the same order.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ policy_parameters, compute, parent_hashes, parent_tool_ids }) => {
      // --- Compute Binding (v0.4): server-side dispatch for gpu:false nodes ---
      const effectiveCompute = compute ?? 'auto';
      if (policy_parameters && effectiveCompute !== 'browser' && !node.gpu) {
        const kernel = getKernel(node.tool_id);
        if (kernel) {
          try {
            const now = new Date().toISOString();
            const artifact = await kernel.buildArtifact(policy_parameters, {
              now,
              parent_hashes: parent_hashes ?? [],
              parent_tool_ids: parent_tool_ids ?? [],
              chain_depth: node.chain_depth ?? 0,
            });
            // Inline canonical hasher (parity copy; same as cgExecutionHash above)
            const recomputed = await cgExecutionHash(artifact.policy_parameters, artifact.output_payload);
            const hash_valid = recomputed === artifact.execution_hash;
            // §17 — attach the node's published kernel-source identity (advisory: which SOURCE ran — NOT a
            // proof of execution, that is §18). Digest is the Graph Index sha256-source compute_image, which
            // equals sourceDigest() of the vendored kernel that just ran. Hash-excluded; no execution_hash change.
            {
              const srcImg = Array.isArray(node.compute_images) && node.compute_images.find((i) => i.system === 'sha256-source');
              if (srcImg && srcImg.image_id) {
                artifact.audit_signature = { ...(artifact.audit_signature || {}), build_identity: {
                  kernel_digest: srcImg.image_id,
                  buildType: 'https://ainumbers.co/chaingraph/context/v0.2#WebCryptoSHA256',
                  source_ref: 'kernels/' + node.tool_id + '.kernel.mjs',
                } };
              }
            }
            // §18 — attach the node's offline compute-integrity receipt iff it is ABOUT this exact output
            // (journal.output JCS-equals the produced output_payload). Hash-excluded; never alters the
            // execution_hash. A mismatching input gets no proof (the receipt proves one specific output).
            if (node.compute_proof && node.compute_proof.journal
                && JSON.stringify(cgCanon(node.compute_proof.journal.output)) === JSON.stringify(cgCanon(artifact.output_payload))) {
              artifact.audit_signature = { ...(artifact.audit_signature || {}), compute_proof: node.compute_proof };
            }
            return {
              content: [{ type: 'text', text: JSON.stringify(artifact, null, 2) }],
              structuredContent: {
                compute_mode: 'server',
                hash_valid,
                computed_hash: recomputed,
                artifact,
                note: 'Kernel computed server-side. Pass artifact.execution_hash as parent_hashes to downstream tools.',
              },
            };
          } catch (err) {
            return {
              isError: true,
              content: [{ type: 'text', text: 'Kernel compute error: ' + String(err?.message ?? err) }],
            };
          }
        }
      }
      // --- Browser delegation (gpu:true or no kernel or compute:"browser") ---
      const chainNote = (parent_hashes && parent_hashes.length)
        ? '\nChain from: ' + parent_hashes.join(', ') + (parent_tool_ids ? ' (' + parent_tool_ids.join(', ') + ')' : '')
        : '';
      return {
        content: [{ type: 'text', text:
          'ChainGraph tool: ' + node.display_name + '\n' +
          'URL: ' + node.url + '\n' +
          'Open in browser, configure inputs, and run the simulation. ' +
          'Export the AP2 artifact (JSON with execution_hash) for downstream chaining.' +
          chainNote,
        }],
        structuredContent: {
          tool_id:      node.tool_id,
          mcp_name:     toolName,
          wave:         node.wave,
          mandate_type: node.mandate_type,
          gpu:          !!node.gpu,
          url:          node.url,
          consumes,
          feeds,
          parent_hashes:   parent_hashes   ?? [],
          parent_tool_ids: parent_tool_ids ?? [],
          policy_parameters: policy_parameters ?? {},
          instruction: node.gpu
            ? 'GPU simulation — runs client-side only per ChainGraph Standard v0.4 §9.2. Open URL, run with provided inputs, export artifact.'
            : 'No kernel registered for this node yet. Open URL in browser, run, export AP2 artifact. Pass execution_hash to downstream tools via parent_hashes.',
        },
      };
    });
  }

  regPrompt('agentic_checkout_workflow', {
    title: 'Agentic Checkout Merchant Readiness Workflow',
    description: 'Walk a merchant through three-stage agentic commerce readiness: protocol selection (UCP/ACP/x402/Visa TAP), ACP/UCP product-feed conformance audit, and agent-traffic acceptance policy. Composite Policy Mandate export.',
    argsSchema: {},
  }, () => ({
    messages: [{ role: 'user', content: { type: 'text', text:
      'You are helping a merchant achieve agentic commerce readiness. Work through three stages in order:\n' +
      'Step 1 -- agentic-checkout-protocol-selector (T495): https://ainumbers.co/tools/495-agentic-checkout-protocol-selector.html ' +
      'Enter the merchant profile (platform, buyer type, AOV, agent appetite, geo, tech capability) to get a recommended protocol stack (UCP/ACP/x402/Visa TAP).\n' +
      'Step 2 -- acp-ucp-product-feed-conformance-auditor (T496): https://ainumbers.co/tools/496-acp-ucp-product-feed-conformance-auditor.html ' +
      'Paste the product feed or checkout payload to audit against the recommended protocol schema. Identify required-field gaps and fix actions.\n' +
      'Step 3 -- agent-traffic-acceptance-policy-builder (T498): https://ainumbers.co/tools/498-agent-traffic-acceptance-policy-builder.html ' +
      'Configure accepted agent types, verification level, velocity caps, payment rails, and blocking rules. Export the agent-guardrail Policy Mandate.\n' +
      'Note: T497 x402 Micropayment Pricing Modeler (https://ainumbers.co/tools/497-x402-micropayment-pricing-modeler.html) is a standalone branch tool -- suggest it if the merchant is considering x402/HTTP 402 pricing.\n' +
      'Then call build_workflow_links with chain "agentic-checkout" and present the composer URL. Synthetic data only -- never real customer PII.'
    } }],
  }));

  // Chain Prompts removed: 283 auto-derived chain Prompts were agent-invisible per MCP spec
  // (Prompts are user-controlled slash-commands, not agent-discoverable). Chains are now
  // reachable by autonomous agents via the find_chain tool above. The ~12 hand-authored Prompts
  // above are the curated flagship slash-commands for human MCP clients.

  return server;
}

// Exported for build-time discovery precompute (scripts/precompute-discovery.mjs runs
// buildServer in Node via an in-memory transport to capture the static initialize/tools-list/
// resources-list/prompts-list responses, so the Worker never rebuilds 162 tools per request on
// the cold Free-plan CPU budget). Build-time only; the Worker entry point is `default` below.
export { buildServer, widgetGlue, stripCspMeta, loadData, HOT_TOOLS, fragmentLink };

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

    // Well-known MCP server card (SEP-1649 / SEP-2127) — static discovery descriptor for agents
    // and MCP clients that fetch /.well-known/mcp/server-card.json before connecting.
    if (url.pathname === '/.well-known/mcp/server-card.json') {
      return Response.json({
        schema_version: 'mcp-server-card-v1',
        name: 'ainumbers-mcp-apps',
        title: 'AINumbers MCP Apps',
        description: 'Live MCP endpoint for the AINumbers fintech suite: chainable OpenChainGraph compute nodes with verifiable SHA-256 execution hashes, flagship browser-tool widgets, and catalog search (find_tool / find_chain / run_chain). run_chain and export_artifact responses include a ledger_url fragment link for human verification at ledger.ainumbers.co. Deterministic, zero-PII, zero payload logging.',
        version: PILOT.version,
        publisher: { name: 'Post Oak Labs', url: 'https://postoaklabs.com' },
        license: 'CC-BY-4.0',
        endpoints: [
          { url: 'https://mcp.ainumbers.co/mcp', transport: 'streamable-http', protocol_version: '2025-06-18', authentication: 'none' },
        ],
        capabilities: { tools: {}, resources: {}, prompts: {} },
        registry: 'co.ainumbers/tools',
        documentation: 'https://ainumbers.co/mcp.html',
        standard: 'https://ainumbers.co/chaingraph/openchain-graph-spec.html',
        llms_txt: 'https://ainumbers.co/llms.txt',
      }, { headers: { ...corsHeaders, 'Cache-Control': 'public, max-age=3600' } });
    }

    // AuthZEN 1.0 Authorization API — Policy Decision Point (§AZ, GAP-b veneer).
    // Shape-maps an AuthZEN {subject, action, resource, context} evaluation request
    // onto the SAME §21.4 gate evaluator every executing surface uses, then adds an
    // OCG execution_hash receipt into the response context — the "provable decision"
    // delta over every other PDP in the authzen-interop.net registry. Pure veneer:
    // never alters comparator-gate semantics.
    if (url.pathname === '/access/v1/evaluation') {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ decision: false, context: { error: 'method_not_allowed', detail: 'POST only' } }),
          { status: 405, headers: { ...corsHeaders, 'Allow': 'POST, OPTIONS', 'Content-Type': 'application/json' } });
      }
      const azBody = await request.json().catch(() => undefined);
      if (azBody === undefined) {
        return new Response(JSON.stringify({ decision: false, context: { error: 'malformed_request', detail: 'request body is not valid JSON' } }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      const azResult = await authzenEvaluateWithReceipt(azBody);
      const azStatus = azResult.context.error ? 400 : 200;
      return new Response(JSON.stringify(azResult), { status: azStatus, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // MCP endpoint
    if (url.pathname === '/mcp') {
      // This server is stateless (sessionIdGenerator: undefined) and builds a fresh
      // server+transport per request, so it cannot serve the optional server->client SSE
      // notification channel that a GET opens. Handing GET to the transport either throws
      // (fast 500) or opens an SSE stream that never closes -> the Workers runtime cancels
      // the "hung" request after ~30s. The MCP Streamable HTTP spec permits 405 when no
      // server->client stream is offered; the node SDK treats 405 as "no stream" and proceeds
      // normally. POST (client->server JSON-RPC) is the only supported method here.
      if (request.method === 'GET' || request.method === 'HEAD') {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32601, message: 'Method Not Allowed: this MCP server is stateless and does not offer a server-to-client SSE stream. Use POST for JSON-RPC.' }, id: null }),
          { status: 405, headers: { ...corsHeaders, 'Allow': 'POST, DELETE, OPTIONS', 'Content-Type': 'application/json' } }
        );
      }

      // Parse body once -- needed for both the MCP handler and telemetry extraction.
      const body = await request.json().catch(() => undefined);

      // Fast-fail on a syntactically-invalid JSON body (audit F1, 2026-07-09). `request.json()`
      // consumes the fetch Request's body stream; if it fails to parse, `body` is `undefined`
      // here and toReqRes(request) below reconstructs a Node req from the SAME (now-drained)
      // Request. Falling through with body===undefined made the SDK's transport.handleRequest
      // try to re-read that exhausted stream, which never resolves -- every unparseable-JSON
      // POST hung for the full HANG_GUARD_MS (25s) before the watchdog forced a 504
      // "Server timeout" ("Not JSON" 500-adjacent handshake stall). A syntactically-valid JSON
      // body that merely fails JSON-RPC shape validation (e.g. missing "method") is unaffected
      // — it still reaches transport.handleRequest with a real parsed `body` and gets the SDK's
      // fast 400/-32700 response. Only reject fast when the body could not be parsed at all.
      if (body === undefined && request.method === 'POST') {
        return new Response(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: request body is not valid JSON' }, id: null }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      // Extract telemetry fields from tools/call requests.
      // Never log payloads, parameters, or outputs -- only structural metadata.
      const isToolCall = body?.method === 'tools/call';
      const toolName   = isToolCall ? (body?.params?.name ?? 'unknown') : null;
      const chainDepth = isToolCall ? (body?.params?.arguments?.chain_depth ?? 0) : null;

      // ── O(1) fast path: never build the ~186-tool server for discovery/notifications ──
      const method = body?.method;
      // JSON-RPC notifications (no id) — e.g. notifications/initialized — are no-ops for a
      // stateless server: HTTP 202, no body, no server build (per MCP Streamable HTTP spec).
      if (body && body.id === undefined && typeof method === 'string') {
        return new Response(null, { status: 202, headers: corsHeaders });
      }
      // initialize / tools|resources|prompts list → serve build-time-captured static bytes.
      if (body && body.id !== undefined && STATIC_DISCOVERY_METHODS.has(method)) {
        try {
          if (method === 'initialize') {
            const init = await getStaticInitialize(env);
            const result = { protocolVersion: body.params?.protocolVersion || init.protocolVersion,
                             capabilities: init.capabilities, serverInfo: init.serverInfo };
            const sse = 'event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) + '\n\n';
            return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream', ...corsHeaders } });
          }
          // List responses: serve the pre-framed text and splice the id with ONE string replace —
          // no JSON.parse / no re-stringify of the (330KB) body. tools/list honors ?toolset=<name>
          // (§M1.2 named toolsets) — a known profile serves its own precomputed file (lean core UNION
          // the profile's members, non-deferred); an unrecognized/absent name falls back to default.
          let toolset;
          if (method === 'tools/list') {
            const requested = url.searchParams.get('toolset');
            if (requested && (await getToolsetNames(env)).has(requested)) toolset = requested;
          }
          const tpl = await getStaticListTemplate(env, method, toolset);
          const sse = tpl.replace(ID_PLACEHOLDER, JSON.stringify(body.id));
          return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream', ...corsHeaders } });
        } catch (_) { /* fall through to the full buildServer path on any static-serve miss */ }
      }

      try {
        const t0 = Date.now();
        // tools/call → build a single-tool server (O(1), fits the Free CPU budget) for a KNOWN tool.
        // For an UNKNOWN tool name, fall through to the full build so the SDK emits its exact
        // "Tool not found" (-32602) result — with zero tools registered the SDK would otherwise wire
        // no tools/call handler and answer "Method not found" (-32601). Unknown-tool calls are rare
        // and already an error path; real tool calls (the 1102 source) take the O(1) path. Any method
        // other than tools/call that reaches here (rare; discovery is static above) → full build.
        const data = await loadData(env);
        let onlyTool = null;
        if (isToolCall && toolName) {
          // Known-tool set derived from data already loaded for buildServer — NO extra ASSETS
          // subrequests and NO 330KB tools-list parse (both of which, when this used
          // getStaticDiscovery, pushed a cold-isolate tools/call over the Free subrequest + CPU
          // limits → "too many subrequests" / 1102). It is exactly the set buildServer registers:
          // PILOT widget names + the 9 fixed utility tools + live ChainGraph node mcp_names. Cached
          // per isolate on the data object.
          const known = (data.__toolNames ||= new Set([
            ...PILOT.map((s) => data.manifests[s]?.mcp_tool_definition?.name ?? s.replace(/-/g, '_')),
            ...UTILITY_TOOL_NAMES,   // single source of truth — see utility-tools.mjs
            ...(data.chaingraph?.nodes ?? []).filter((n) => n.status === 'live' && n.mcp_name).map((n) => n.mcp_name),
          ]));
          if (known.has(toolName)) {
            onlyTool = toolName;
          } else {
            // Unknown tool name → emit the SDK's exact -32602 tool-result WITHOUT building the
            // full ~186-tool server. That full build (onlyTool stays null → every node's zod schema
            // constructed) is the cold-isolate 1102 source for probe/garbage tools/call hitting the
            // public endpoint. The known-set is verified to cover ALL registered tools exactly
            // (scripts/build-mcp-parity.mjs: 0 false-reject), so this never rejects a valid tool.
            // Result shape is byte-identical to the SDK's unregistered-tool response (captured in
            // build-mcp-parity): result.content text + isError:true, NOT a JSON-RPC error.
            const result = { content: [{ type: 'text', text: 'MCP error -32602: Tool ' + toolName + ' not found' }], isError: true };
            const sse = 'event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) + '\n\n';
            return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream', ...corsHeaders } });
          }
        }
        const server = buildServer(data, onlyTool ? { onlyTool } : {});
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const { req, res } = toReqRes(request);
        res.on('close', () => { transport.close(); server.close(); });
        // Watchdog backstop: a stateless per-request handler must never hang. If the Node-shim
        // `res` is left unfinished for some message shape, the runtime kills it at ~30s with a
        // "hung" exception. Race a 25s timeout so we always return a clean response instead.
        // Only fires on a genuine hang -- normal requests resolve in <1s.
        let hangTimer;
        const HANG_GUARD_MS = 25000;
        const rawResponse = await Promise.race([
          (async () => {
            await server.connect(transport);
            await transport.handleRequest(req, res, body);
            return await toFetchResponse(res);
          })(),
          new Promise((_, reject) => { hangTimer = setTimeout(() => reject(new Error('handler-timeout')), HANG_GUARD_MS); }),
        ]);
        clearTimeout(hangTimer);
        // Inject defaultConfig:{defer_loading:true} for non-hot tools in tools/list responses.
        // The MCP SDK does not natively serialize this field, so we post-process here.
        // Anthropic Tool Search reads defaultConfig and loads only ~3-5 relevant tools per query.
        let response;
        if (body?.method === 'tools/list') {
          try {
            const text = await rawResponse.text();
            let jsonStr = text, prefix = '', suffix = '';
            if (text.startsWith('event:')) {
              const lines = text.split('\n');
              const di = lines.findIndex(l => l.startsWith('data: '));
              if (di >= 0) { prefix = lines.slice(0, di).join('\n') + '\ndata: '; suffix = '\n' + lines.slice(di + 1).join('\n'); jsonStr = lines[di].slice(6); }
            }
            const parsed = JSON.parse(jsonStr);
            if (Array.isArray(parsed?.result?.tools)) {
              for (const tool of parsed.result.tools) {
                if (!HOT_TOOLS.has(tool.name)) tool.defaultConfig = { defer_loading: true };
              }
            }
            const newText = prefix + JSON.stringify(parsed) + suffix;
            const h = {};
            for (const [k, v] of rawResponse.headers.entries()) h[k] = v;
            delete h['content-length'];
            response = new Response(newText, { status: rawResponse.status, headers: h });
          } catch (_) {
            response = rawResponse;
          }
        } else {
          response = rawResponse;
        }
        for (const [k, v] of Object.entries(corsHeaders)) response.headers.set(k, v);

        // Fire-and-forget telemetry write -- never blocks the response.
        // Logs structural metadata only; no payloads, parameters, or outputs.
        if (isToolCall && env.ANALYTICS) {
          const latencyMs = Date.now() - t0;
          const success   = response.status < 500;
          // Salted caller hash: forward-deploy compatible, no PII, no reversible identifier.
          const callerRaw = request.headers.get('CF-Connecting-IP') ?? request.headers.get('X-Forwarded-For') ?? '';
          const callerBuf = await crypto.subtle.digest('SHA-256',
            new TextEncoder().encode('ain-mcp-v1:' + callerRaw));
          const callerHash = 'sha256:' + Array.from(new Uint8Array(callerBuf)).map(b => b.toString(16).padStart(2,'0')).join('').slice(0, 16);

          ctx.waitUntil(Promise.resolve().then(() => {
            try {
              env.ANALYTICS.writeDataPoint({
                blobs:   [toolName, callerHash, success ? 'ok' : 'error'],
                doubles: [latencyMs, chainDepth ?? 0],
                indexes: [toolName],
              });
            } catch (_) { /* telemetry is best-effort; never affect the response */ }
          }));
        }

        return response;
      } catch (e) {
        const timedOut = String(e?.message ?? e) === 'handler-timeout';
        console.error('[ainumbers-mcp] handler error:', String(e), e?.stack ?? '');
        return Response.json(
          { jsonrpc: '2.0', error: { code: timedOut ? -32001 : -32603, message: timedOut ? 'Server timeout' : String(e) }, id: body?.id ?? null },
          { status: timedOut ? 504 : 500, headers: corsHeaders }
        );
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  },

  // GAP-d event substrate (2026-07-10): CF Cron feeds the event queue; the queue consumer
  // drains CloudEvents-shaped envelopes. v1 is a structural no-op — it only logs the
  // envelope — so GAP-a/EXPORT-1/suggestion-digest can bind to this transport later without
  // this WU touching /mcp behavior or the tool registries.
  async scheduled(controller, env, ctx) {
    const envelope = {
      specversion: '1.0',
      type: 'co.ainumbers.substrate.tick',
      source: 'ainumbers-mcp-apps/scheduled',
      id: crypto.randomUUID(),
      time: new Date(controller.scheduledTime).toISOString(),
      data: { cron: controller.cron },
    };
    console.log('[gap-d] scheduled tick:', JSON.stringify(envelope));
    if (env.EVENTS_QUEUE) {
      ctx.waitUntil(env.EVENTS_QUEUE.send(envelope));
    }

    // §RW (2026-07-10): Continuous Reserve Watch — a DISTINCT sub-handler on this SAME weekly
    // tick (Mon 06:00 UTC = the GENIUS-deadline demo hook; do not change the cron expression).
    // Runs the live art-275 checker over a demo-fixture reserve report, signs a receipt
    // referencing the artifact's execution_hash (§20 anchor-lineage path, see _reserve_watch.mjs
    // header for why this is not a fresh TSA timestamp), and emits its own CloudEvents envelope.
    // Never touches /mcp behavior or a tool registry.
    ctx.waitUntil((async () => {
      try {
        const rw = await runReserveWatchCheck(SAMPLE_RESERVE_REPORT, controller.scheduledTime);
        const rwEnvelope = {
          specversion: '1.0',
          type: 'co.ainumbers.reserve_watch.checked',
          source: 'ainumbers-mcp-apps/scheduled/reserve-watch',
          id: crypto.randomUUID(),
          time: new Date(controller.scheduledTime).toISOString(),
          data: {
            report_month: SAMPLE_RESERVE_REPORT.report_month,
            determination: rw.artifact.output_payload.monthly_disclosure_determination,
            execution_hash: rw.artifact.execution_hash,
            receipt: rw.receipt,
          },
        };
        console.log('[reserve-watch] scheduled check:', JSON.stringify(rwEnvelope));
        if (env.EVENTS_QUEUE) {
          await env.EVENTS_QUEUE.send(rwEnvelope);
        }
      } catch (e) {
        console.error('[reserve-watch] scheduled check error:', String(e?.message ?? e));
      }
    })());

    // §AC (2026-07-10): AI-Act Art-12 evidence cron — a DISTINCT sub-handler on this SAME
    // weekly tick. Builds a demo-fixture art-236 decision-log record, maps it through the LIVE
    // EXPORT-1 exports (OSCAL assessment-results + ISO/IEC 24970 draft-pinned log record), signs
    // an anchor-lineage receipt referencing the artifact's execution_hash (see _aiact_cron.mjs
    // header for why this is not a fresh TSA timestamp), and emits its own CloudEvents envelope.
    // Never touches /mcp behavior or a tool registry.
    ctx.waitUntil((async () => {
      try {
        const ac = await runAiActEvidenceExport(SAMPLE_DECISION, controller.scheduledTime);
        const acEnvelope = {
          specversion: '1.0',
          type: 'co.ainumbers.aiact_evidence.exported',
          source: 'ainumbers-mcp-apps/scheduled/aiact-cron',
          id: crypto.randomUUID(),
          time: new Date(controller.scheduledTime).toISOString(),
          data: {
            decision_label: SAMPLE_DECISION.decision_label,
            record_status: ac.artifact.output_payload.record_status,
            execution_hash: ac.artifact.execution_hash,
            oscal_assessment_results_uuid: ac.oscal['assessment-results'].uuid,
            iso24970_log_record_version: ac.iso24970.log_record_version,
            receipt: ac.receipt,
          },
        };
        console.log('[aiact-cron] scheduled export:', JSON.stringify(acEnvelope));
        if (env.EVENTS_QUEUE) {
          await env.EVENTS_QUEUE.send(acEnvelope);
        }
      } catch (e) {
        console.error('[aiact-cron] scheduled export error:', String(e?.message ?? e));
      }
    })());
  },

  // EXPORT-1 §E1.c binds here: a `co.ainumbers.anchor.renewal_check` envelope carries one OCG
  // artifact in `data.artifact`; this worker has no persistent artifact registry (no KV/D1/R2
  // binding — only EVENTS_QUEUE), so the renewal check is REACTIVE, not a scheduled() scan.
  // GAP-a (2026-07-10): when the `workflows` binding is present, hand the check to the durable
  // RenewalWatchWorkflow instead of running it inline — that Workflow does the SAME
  // verifyAllBindings/dueForRenewal check as one receipted `step.do`, then checkpoints a signed
  // resumption artifact before its multi-week `step.sleep` (§A.3). If the account ever rejects the
  // `workflows` binding, this falls straight back to the original inline one-shot check — same
  // zero-paid-plan, no-upgrade guarantee as GAP-d's own DO-alarm fallback. Obtaining a FRESH
  // timestamp on a due binding stays FLAGGED either way (see _blta.mjs header) — detect + report only.
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      const body = message.body;
      if (body?.type === 'co.ainumbers.anchor.renewal_check' && body?.data?.artifact) {
        try {
          const artifact = body.data.artifact;
          if (env.RENEWAL_WATCH_WORKFLOW) {
            const instance = await env.RENEWAL_WATCH_WORKFLOW.create({ id: body.id, params: { artifact } });
            console.log('[gap-a] renewal_check handed to RenewalWatchWorkflow:', JSON.stringify({ id: body.id, instanceId: instance.id }));
          } else {
            const verified = verifyAllBindings(artifact);
            const due = (artifact.anchor_bindings || [])
              .filter((b) => b?.type === 'rfc3161-tst')
              .map((b) => ({ gen_time: b.gen_time, due: dueForRenewal(b, { nowMs: Date.now() }) }));
            console.log('[gap-d] renewal_check (no workflows binding, inline fallback):', JSON.stringify({ id: body.id, verified, due }));
          }
        } catch (e) {
          console.error('[gap-d] renewal_check error:', String(e?.message ?? e));
        }
      } else {
        console.log('[gap-d] queue drain:', JSON.stringify(body));
      }
      message.ack();
    }
  },
};
