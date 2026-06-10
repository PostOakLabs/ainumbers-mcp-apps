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
    description: 'Velocity rule building > structuring pattern detection > fraud investigation > APP-scam risk scoring > fraud/velocity policy mandate.',
    composer_url: BASE_URL + '/guides/fraud-decisioning-composer.html',
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
    composer_url: BASE_URL + '/guides/credit-decisioning-composer.html',
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
    composer_url: BASE_URL + '/guides/stablecoin-compliance-composer.html',
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
    composer_url: BASE_URL + '/guides/instant-payments-vop-composer.html',
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
    composer_url: BASE_URL + '/guides/einvoicing-vida-composer.html',
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
    composer_url: BASE_URL + '/guides/crypto-tax-reporting-composer.html',
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
    composer_url: BASE_URL + '/guides/bank-capital-liquidity-composer.html',
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
    composer_url: BASE_URL + '/guides/pillar-two-globe-composer.html',
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
    composer_url: BASE_URL + '/guides/amlr-single-rulebook-composer.html',
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
    composer_url: BASE_URL + '/guides/eudi-wallet-acceptance-composer.html',
    steps: [
      { slug: '489-eudi-attribute-attestation-mapper',              handoff: 'pid_attributes and qeaa_map feed Stage 2 KYC flow' },
      { slug: '490-eudi-kyc-flow-designer',                        handoff: 'kyc_flow_steps feed Stage 3 RP registration check' },
      { slug: '491-eudi-relying-party-registration-checker',       handoff: 'rp_registration_status feeds Stage 4 readiness' },
      { slug: '348-eidas2-eudi-wallet-relying-party-readiness-scorer', handoff: 'Exports EUDI Acceptance Mandate -- final stage' },
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
  const server = new McpServer({ name: 'ainumbers-apps', version: '0.10.0' });

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
    description: 'Step-by-step fraud & scam decisioning workflow: velocity rule building > structuring pattern detection > fraud investigation > APP-scam scoring, composite velocity-rule Policy Mandate.',
    argsSchema: {},
  }, async () => {
    return {
      description: 'Fraud & Scam Decisioning workflow -- T256 > T117 > T80 > T322, composite Policy Mandate export.',
      messages: [{ role: 'user', content: { type: 'text', text:
        'Walk me through a complete fraud & scam decisioning run using AINumbers browser tools. All tools run client-side -- zero PII, zero network. Use synthetic data only.\n\n' +
        'Step 1 -- Build workflow links: call `build_workflow_links` with chain "fraud-decisioning". Returns the ordered deep-link set and the composer URL.\n\n' +
        'Step 2 -- Orchestrated run: open the Fraud Decisioning Composer at ' + BASE_URL + '/guides/fraud-decisioning-composer.html. ' +
        'Stage 1 (T256) builds real-time fraud velocity/limit rules. Stage 2 (T117) detects structuring and layering patterns against the ruled flows. Stage 3 (T80) runs fraud investigation and typology matching on flagged cases. Stage 4 (T322) scores APP-scam risk and reimbursement liability (UK PSR PS25/5 / FCA-PSR Joint Framework). Mandate type: velocity_rule_mandate.\n\n' +
        'After the run: present the composite Policy Mandate JSON for payment-engine guardrails. Recommend re-running after any material change to fraud typologies, velocity thresholds, or PSR guidance.',
      }}],
    };
  });

  server.registerPrompt('credit_decisioning_workflow', {
    description: 'Step-by-step credit decisioning workflow: PD/LGD modelling > Basel RWA > RAROC pricing > covenant compliance > facility structuring, composite credit Policy Mandate.',
    argsSchema: {},
  }, async () => {
    return {
      description: 'Credit Decisioning workflow -- T198 > T201 > T437 > T199 > T435, composite Policy Mandate export.',
      messages: [{ role: 'user', content: { type: 'text', text:
        'Walk me through a complete credit decisioning run using AINumbers browser tools. All tools run client-side -- zero PII. Use synthetic data only.\n\n' +
        'Step 1 -- Build workflow links: call `build_workflow_links` with chain "credit-decisioning". Returns the ordered deep-link set and the composer URL.\n\n' +
        'Step 2 -- Orchestrated run: open the Credit Decisioning Composer at ' + BASE_URL + '/guides/credit-decisioning-composer.html. ' +
        'Stage 1 (T198) models PD/LGD/EAD under Basel IRB. Stage 2 (T201) calculates RWA and capital requirements. Stage 3 (T437) prices RAROC and verifies hurdle rate. Stage 4 (T199) checks financial covenant compliance. Stage 5 (T435) structures the credit facility (limits, tranches, covenant package). Mandate type: credit_assessment, valid 180 days.\n\n' +
        'IMPORTANT: Do NOT independently compute capital or pricing figures -- use Stage 2 and Stage 3 tool outputs only.\n\n' +
        'After the run: present the composite Policy Mandate JSON as the credit committee decision record. Re-run after any material change to PD models, capital floors, or EBA GL/2020/06 guidance.',
      }}],
    };
  });

  server.registerPrompt('consumer_protection_workflow', {
    description: 'Step-by-step FCA Consumer Duty workflow: vulnerability assessment > fair value > MiFID costs & charges > PRIIPs KID > Consumer Duty board MI, composite consumer-protection Policy Mandate.',
    argsSchema: {},
  }, async () => {
    return {
      description: 'Consumer Protection workflow -- T395 > T396 > T428 > T448 > T397, composite Policy Mandate export.',
      messages: [{ role: 'user', content: { type: 'text', text:
        'Walk me through a complete FCA Consumer Duty compliance run using AINumbers browser tools. All tools run client-side -- zero PII. Use synthetic data only.\n\n' +
        'Step 1 -- Build workflow links: call `build_workflow_links` with chain "consumer-protection". Returns the ordered deep-link set and the composer URL.\n\n' +
        'Step 2 -- Orchestrated run: open the Consumer Protection Composer at ' + BASE_URL + '/guides/consumer-protection-composer.html. ' +
        'Stage 1 (T395) builds the Consumer Duty vulnerability assessment (FCA PS22/9). Stage 2 (T396) evaluates product price & fair-value outcomes. Stage 3 (T428) calculates MiFID II costs & charges. Stage 4 (T448) checks PRIIPs KID disclosure compliance (PRIIPs 1286/2014). Stage 5 (T397) builds the Consumer Duty board MI framework. Mandate type: disclosure_template, valid 365 days.\n\n' +
        'After the run: present the composite Policy Mandate JSON for product governance review. Re-run annually or after any material product or pricing change.',
      }}],
    };
  });

  server.registerPrompt('stablecoin_compliance_workflow', {
    description: 'Step-by-step stablecoin compliance workflow: issuance architecture > reserve stress test > GENIUS Act compliance > MiCA white paper, composite stablecoin compliance Policy Mandate.',
    argsSchema: {},
  }, async () => {
    return {
      description: 'Stablecoin Compliance workflow -- T53 > T388 > T386 > T390, composite Policy Mandate export.',
      messages: [{ role: 'user', content: { type: 'text', text:
        'Walk me through a complete stablecoin compliance run using AINumbers browser tools. Covers US GENIUS Act and EU MiCA. All tools run client-side -- zero PII. Use synthetic data only.\n\n' +
        'Step 1 -- Build workflow links: call `build_workflow_links` with chain "stablecoin-compliance". Returns the ordered deep-link set and the composer URL.\n\n' +
        'Step 2 -- Orchestrated run: open the Stablecoin Compliance Composer at ' + BASE_URL + '/guides/stablecoin-compliance-composer.html. ' +
        'Stage 1 (T53) compares issuance/architecture models. Stage 2 (T388) stress-tests reserve composition and adequacy. Stage 3 (T386) checks US GENIUS Act payment-stablecoin compliance. Stage 4 (T390) builds the EU MiCA white paper / CASP path (MiCA 2023/1114). Mandate type: compliance_control, valid 180 days.\n\n' +
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

  server.registerPrompt('instant_payments_vop_workflow', {
    title: 'Instant Payments & VoP Readiness Workflow',
    description: 'Walk a PSP through EU Instant Payments Regulation readiness: rail participation, Verification of Payee, intraday liquidity, and the IPR annual report.',
    argsSchema: {},
  }, async () => {
    return {
      description: 'Instant Payments & VoP workflow -- T229 > T289 > T258 > T349 > T259, composite Policy Mandate export.',
      messages: [{ role: 'user', content: { type: 'text', text:
        'You are helping a PSP/EMI assess EU Instant Payments Regulation readiness using AINumbers deterministic tools (VoP mandatory since 9 Oct 2025). ' +
        'All tools run client-side -- zero PII, zero network. Use synthetic payment data only -- never real account details.\n\n' +
        'Step 1 -- Build workflow links: call `build_workflow_links` with chain "instant-payments-vop". Returns the ordered deep-link set (T229 > T289 > T258 > T349 > T259) and the composer URL.\n\n' +
        'Step 2 -- Orchestrated run: open the Instant Payments & VoP Composer at ' + BASE_URL + '/guides/instant-payments-vop-composer.html. ' +
        'Stage 1 (T229) checks RTP/SEPA Instant rail participation readiness. ' +
        'Stage 2 (T289) simulates VoP match/close-match/no-match flows and response timing (mandatory since 9 Oct 2025). ' +
        'Stage 3 (T258) sizes the intraday credit facility for 24/7 instant settlement. ' +
        'Stage 4 (T349) assembles the SEPA IPR annual compliance report. ' +
        'Stage 5 (T259) builds the RTP routing policy mandate. Mandate type: routing_policy_mandate.\n\n' +
        'After the run: present the composite Policy Mandate JSON as the IPR readiness artefact. Re-run after any material change to participation status, VoP match rates, or intraday credit limits.',
      }}],
    };
  });

  server.registerPrompt('baas_sponsor_bank_workflow', {
    title: 'BaaS / Sponsor-Bank Readiness Workflow',
    description: 'Walk a fintech or sponsor bank through BaaS programme design: provider selection, FBO/ledger architecture, BSA/AML controls, and readiness scoring.',
    argsSchema: {},
  }, async () => {
    return {
      description: 'BaaS / Sponsor-Bank workflow -- T152 > T153 > T154 > T158 > T162, composite Policy Mandate export.',
      messages: [{ role: 'user', content: { type: 'text', text:
        'You are helping a fintech or sponsor bank build a defensible BaaS programme using AINumbers deterministic tools (post-Synapse, focus on reconciliation and third-party BSA/AML oversight). ' +
        'All tools run client-side -- zero PII, zero network. Use synthetic programme data only.\n\n' +
        'Step 1 -- Build workflow links: call `build_workflow_links` with chain "baas-sponsor-bank". Returns the ordered deep-link set (T152 > T153 > T154 > T158 > T162) and the composer URL.\n\n' +
        'Step 2 -- Orchestrated run: open the BaaS / Sponsor-Bank Composer at ' + BASE_URL + '/guides/baas-sponsor-bank-composer.html. ' +
        'Stage 1 (T152) scores and compares BaaS providers/sponsor-bank partners. ' +
        'Stage 2 (T153) models the FBO account structure and reconciliation architecture (the Synapse failure point). ' +
        'Stage 3 (T154) designs the ledger topology supporting the FBO model. ' +
        'Stage 4 (T158) maps BSA/AML and consumer-protection controls (third-party oversight gaps cited in post-Synapse enforcement actions). ' +
        'Stage 5 (T162) scores sponsor-bank programme readiness. Mandate type: compliance_control.\n\n' +
        'CRITICAL: Do not launch a BaaS programme until Stage 4 control_gaps are fully remediated and Stage 5 readiness_score exceeds threshold. ' +
        'Re-run after any change to partner structure, ledger architecture, or FinCEN/OCC/FDIC guidance.',
      }}],
    };
  });

  server.registerPrompt('einvoicing_vida_workflow', {
    title: 'E-Invoicing & ViDA Workflow',
    description: 'Walk a finance/tax user through EU ViDA digital-reporting readiness, e-invoice compliance, Peppol XML, and ISO 20022 mapping.',
    argsSchema: {},
  }, async () => {
    return {
      description: 'E-Invoicing & ViDA workflow -- T179 > T180 > T174 > T178, composite Policy Mandate export.',
      messages: [{ role: 'user', content: { type: 'text', text:
        'You are helping a finance/tax team prepare for EU ViDA e-invoicing and digital reporting using AINumbers deterministic tools (member-state mandates 2026-2028, EU-wide 2030). ' +
        'All tools run client-side -- zero PII, zero network. Use synthetic invoice data only.\n\n' +
        'Step 1 -- Build workflow links: call `build_workflow_links` with chain "einvoicing-vida". Returns the ordered deep-link set (T179 > T180 > T174 > T178) and the composer URL.\n\n' +
        'Step 2 -- Orchestrated run: open the E-Invoicing & ViDA Composer at ' + BASE_URL + '/guides/einvoicing-vida-composer.html. ' +
        'Stage 1 (T179) scores readiness against ViDA Digital Reporting Requirements. ' +
        'Stage 2 (T180) checks B2B e-invoice compliance against EN16931 (mandatory semantic data model). ' +
        'Stage 3 (T174) audits the Peppol/UBL XML structure against BIS Billing 3.0 rules. ' +
        'Stage 4 (T178) maps the validated invoice to ISO 20022 payment instruction for STP. Mandate type: compliance_control.\n\n' +
        'Member-state mandate deadlines: Belgium Jan 2026, Poland Feb 2026, France Sept 2026, Germany Jan 2027, EU-wide intra-B2B 1 Jul 2030. Verify jurisdiction-specific deadline before reliance.\n\n' +
        'After the run: present the composite Policy Mandate JSON as the ViDA readiness artefact. Re-run after any ERP/billing system change or member-state guidance update.',
      }}],
    };
  });

  server.registerPrompt('us_banking_compliance_workflow', {
    title: 'US Consumer-Banking Compliance Workflow',
    description: 'Walk a US bank/credit-union compliance user through HMDA, BSA/SAR, Reg E, and Durbin checks.',
    argsSchema: {},
  }, async () => {
    return {
      description: 'US Consumer-Banking Compliance workflow -- T444 > T445 > T442 > T443, composite Policy Mandate export.',
      messages: [{ role: 'user', content: { type: 'text', text:
        'You are helping a US bank/credit-union compliance user using AINumbers deterministic tools -- do not guess thresholds, call the tools. ' +
        'All tools run client-side -- zero PII, zero network. Use synthetic data only -- never real customer PII.\n\n' +
        'Step 1 -- Build workflow links: call `build_workflow_links` with chain "us-banking-compliance". Returns the ordered deep-link set (T444 > T445 > T442 > T443) and the composer URL.\n\n' +
        'Step 2 -- Orchestrated run: open the US Consumer-Banking Compliance Composer at ' + BASE_URL + '/guides/us-banking-compliance-composer.html. ' +
        'Stage 1 (T444) checks HMDA reportability and LAR data-field completeness (12 CFR Part 1003). ' +
        'Stage 2 (T445) checks BSA/SAR filing adequacy against FinCEN thresholds (31 CFR 1020.320). ' +
        'Stage 3 (T442) builds Reg E error-resolution timelines (12 CFR Part 1005 §1005.11). ' +
        'Stage 4 (T443) analyses Durbin Amendment interchange eligibility and cap economics (12 CFR Part 235). Mandate type: compliance_control.\n\n' +
        'Threshold note: Durbin cap ($0.21 + 0.05%) applies to issuers with ≥$10B assets -- verify current asset threshold annually. ' +
        'SAR filing window: 30 days from detection (60 days complex cases). HMDA LAR deadline: 1 March of the following calendar year.\n\n' +
        'After the run: present the composite Policy Mandate JSON as the consumer-banking compliance record. Re-run after any regulatory guidance update or material change to loan volumes, account structures, or interchange programmes.',
      }}],
    };
  });

  server.registerPrompt('wealth_advisory_regbi_workflow', {
    title: 'US Wealth & Advisory Reg BI Suitability Workflow',
    description: 'Walk a US broker-dealer or RIA through the SEC Reg BI suitability chain: model portfolio risk, best-interest four-obligation check, portfolio construction/rebalancing, costs disclosure, and Form CRS generation.',
    argsSchema: {},
  }, async () => {
    return {
      description: 'US Wealth & Advisory Reg BI Suitability workflow -- T429 > T463 > T432 > T428 > T464, composite Policy Mandate export.',
      messages: [{ role: 'user', content: { type: 'text', text:
        'You are helping a US broker-dealer or investment adviser compliance team run the SEC Regulation Best Interest suitability chain using AINumbers deterministic tools. ' +
        'All tools run client-side -- zero PII, zero network. Use synthetic or anonymised client data only -- never real customer PII.\n\n' +
        'Step 1 -- Build workflow links: call `build_workflow_links` with chain "wealth-advisory-regbi". Returns the ordered deep-link set (T429 > T463 > T432 > T428 > T464) and the composer URL.\n\n' +
        'Step 2 -- Orchestrated run: open the US Wealth & Advisory Reg BI Suitability Composer at ' + BASE_URL + '/guides/wealth-advisory-regbi-composer.html. ' +
        'Stage 1 (T429) calculates model portfolio risk metrics: expected return, volatility, Sharpe, VaR 95%, and tracking error. ' +
        'Stage 2 (T463) scores the recommendation against all four Reg BI obligations (Disclosure, Care, Conflict of Interest, Compliance) -- verdict must be BEST_INTEREST_MET or ATTENTION to proceed. ' +
        'Stage 3 (T432) constructs or rebalances the portfolio to the target allocation and estimates rebalancing trade costs. ' +
        'Stage 4 (T428) calculates ex-ante costs and charges under MiFID II / PRIIPs KID methodology: total cost, RIY, and standardised disclosure table. ' +
        'Stage 5 (T464) generates the Form CRS with SEC-prescribed headings and verbatim conversation-starter questions; checks page-count compliance (2-page BD/IA; 4-page dual-registrant). Mandate type: compliance_control.\n\n' +
        'Reg BI scope note: Exchange Act Rule 15l-1 applies to all US broker-dealer recommendations to retail customers (natural persons with accounts primarily for personal, family, or household purposes). ' +
        '2026 FINRA examination priorities explicitly list Reg BI and Form CRS -- re-run after any material change to the recommendation or client profile.\n\n' +
        'After the run: present the composite Policy Mandate JSON as the Reg BI suitability record. Form CRS must be delivered to the retail customer at or before the recommendation.',
      }}],
    };
  });

  server.registerPrompt('bnpl_programme_workflow', {
    title: 'BNPL Programme — FCA Regulation Workflow',
    description: 'Walk a BNPL lender or fintech through the UK FCA BNPL programme chain: FCA readiness, affordability modelling, APR calculation, disclosure templates, and arrears/collections policy assessment.',
    argsSchema: {},
  }, async () => {
    return {
      description: 'BNPL Programme FCA regulation workflow -- T187 > T190 > T193 > T191 > T192, composite Policy Mandate export.',
      messages: [{ role: 'user', content: { type: 'text', text:
        'You are helping a BNPL lender or fintech prepare for UK FCA BNPL regulation using AINumbers deterministic tools. ' +
        'FCA BNPL regulation comes into force 15 July 2026. ' +
        'All tools run client-side -- zero PII, zero network. Use synthetic or anonymised programme data only.\n\n' +
        'Step 1 -- Build workflow links: call `build_workflow_links` with chain "bnpl-programme". Returns the ordered deep-link set (T187 > T190 > T193 > T191 > T192) and the composer URL.\n\n' +
        'Step 2 -- Orchestrated run: open the BNPL Programme Composer at ' + BASE_URL + '/guides/bnpl-programme-composer.html. ' +
        'Stage 1 (T187) assesses FCA BNPL regulatory readiness: Consumer Duty gaps, programme authorisation gaps, affordability policy review. ' +
        'Stage 2 (T190) models customer affordability: income-to-repayment stress test, existing credit commitments, CCA-compliant capacity check. ' +
        'Stage 3 (T193) calculates the representative APR and total charge for credit under FCA CCA / Consumer Credit Directive methodology. ' +
        'Stage 4 (T191) generates FCA-required pre-contract disclosure templates: PCCI, Financial Promotions compliance checklist, Summary Box. APR from Stage 3 must appear in all disclosure fields. ' +
        'Stage 5 (T192) evaluates arrears management and collections policy against FCA Consumer Duty, CONC 7, and FCA BNPL collections requirements. Mandate type: compliance_control.\n\n' +
        'Key deadlines: FCA BNPL regulation in force 15 Jul 2026 (PS26/5). Firms offering BNPL products without FCA authorisation after that date are operating unlawfully. ' +
        'Consumer Duty effective from 31 Jul 2023 -- a CONC 5 affordability assessment must be proportionate to the credit risk.\n\n' +
        'After the run: present the composite Policy Mandate JSON as the BNPL programme compliance record. Re-run whenever product terms, customer profile, or programme policies change materially.',
      }}],
    };
  });

  server.registerPrompt('pi_emi_authorisation_workflow', {
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

  server.registerPrompt('crypto_tax_reporting_workflow', {
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

  server.registerPrompt('bank_capital_liquidity_workflow', {
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

  server.registerPrompt('pillar_two_globe_workflow', {
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

  // Wave 6 prompts

  server.registerPrompt('ccd2_consumer_credit_workflow', {
    title: 'EU Consumer Credit (CCD2) Workflow',
    description: 'Walk an EU consumer-credit / BNPL provider through CCD2 scope, Article 18 creditworthiness, SECCI disclosure, and readiness.',
    argsSchema: {},
  }, () => ({
    messages: [{ role: 'user', content: { type: 'text', text:
      'You are helping an EU consumer-credit / BNPL / point-of-sale-finance provider prepare for CCD2 (Directive (EU) 2023/2225, applies 20 Nov 2026) using AINumbers deterministic tools -- do not guess scope or APR, call the tools. ' +
      'Step 1 -- ccd2-scope-classifier: open https://ainumbers.co/tools/481-ccd2-scope-classifier.html ' +
      'Step 2 -- ccd2-creditworthiness-assessment-builder: https://ainumbers.co/tools/482-ccd2-creditworthiness-assessment-builder.html ' +
      'Step 3 -- ccd2-secci-precontractual-disclosure-generator: https://ainumbers.co/tools/483-ccd2-secci-precontractual-disclosure-generator.html ' +
      'Step 4 -- ccd2-readiness-scorer: https://ainumbers.co/tools/484-ccd2-readiness-scorer.html ' +
      'Then call build_workflow_links with chain "ccd2-consumer-credit" and present the composer URL. ' +
      'CCD2 is the EU regime -- distinct from the UK FCA BNPL rules (T187-T194); do not conflate them. Synthetic data only -- never real borrower PII.'
    } }],
  }));

  server.registerPrompt('amlr_single_rulebook_workflow', {
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

  server.registerPrompt('eudi_wallet_acceptance_workflow', {
    title: 'eIDAS 2.0 / EUDI Wallet Acceptance Workflow',
    description: 'Walk an EU relying party through EUDI Wallet attribute attestation mapping, KYC flow design, RP registration, and readiness. EUDI Wallet available 31 Dec 2026; FI SCA acceptance ~Dec 2027.',
    argsSchema: {},
  }, () => ({
    messages: [{ role: 'user', content: { type: 'text', text:
      'You are helping an EU relying party (FI, payment institution, or other regulated entity) prepare to accept the EUDI Wallet under eIDAS 2.0 (Regulation (EU) 2024/1183). EUDI Wallet available in all EU MS by 31 Dec 2026. Regulated FIs performing SCA must accept EUDI Wallet credentials by ~Dec 2027 (Art. 5f -- 36 months from implementing acts). ' +
      'Step 1 -- eudi-attribute-attestation-mapper: https://ainumbers.co/tools/489-eudi-attribute-attestation-mapper.html ' +
      'Step 2 -- eudi-kyc-flow-designer: https://ainumbers.co/tools/490-eudi-kyc-flow-designer.html ' +
      'Step 3 -- eudi-relying-party-registration-checker: https://ainumbers.co/tools/491-eudi-relying-party-registration-checker.html ' +
      'Step 4 -- eidas2-eudi-wallet-relying-party-readiness-scorer (T348): https://ainumbers.co/tools/348-eidas2-eudi-wallet-relying-party-readiness-scorer.html ' +
      'Then call build_workflow_links with chain "eudi-wallet-acceptance" and present the composer URL. Synthetic data only -- never real customer PII.'
    } }],
  }));

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
