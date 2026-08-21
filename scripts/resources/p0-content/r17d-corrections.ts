// R1.7D-FINAL — the authorised content corrections, expressed as pure,
// deterministic transforms over a record's reader-facing fields.
//
// Every transform is evidence-driven and traceable to a specific spec
// clause. Nothing here rewrites approved substance or tone (spec §10);
// each rule targets an internal-instruction leak, an internal-only source
// reference a reader cannot access (§7), an inaccurate methodology claim
// (§19), or a CMS label that was never reader-facing text (§23).
//
// Pure by design so the loader can dry-run, diff, log, re-run for
// idempotency (§48) and reconcile hashes (§32) without touching the DB.

export type Block = { id: string; type: string; data: Record<string, unknown> };

export interface RecordInput {
  content_id: string;
  content_type: string;
  excerpt: string | null;
  seo_description: string | null;
  content_blocks: Block[];
}

export interface ChangeLogEntry {
  content_id: string;
  rule: string;
  spec_clause: string;
  location: string;
  classification: 'INTERNAL_INSTRUCTION_REMOVE' | 'INTERNAL_INSTRUCTION_MOVE_TO_METADATA' | 'REWORD_FOR_PUBLIC_READER';
  before: string;
  after: string;
  reason: string;
}

export interface CorrectionResult {
  content_id: string;
  changed: boolean;
  excerpt: string | null;
  seo_description: string | null;
  content_blocks: Block[];
  changes: ChangeLogEntry[];
  /** Internal-only references lifted out of public Sources, preserved per §7. */
  internal_references_preserved: string[];
}

const FHIP_EXPLAINERS = ['EX-001', 'EX-002', 'EX-003', 'EX-004', 'EX-005', 'EX-006', 'EX-007', 'EX-008', 'EX-009', 'EX-010', 'EX-011', 'EX-012', 'EX-025', 'EX-026'];
const VIDEOS = ['VID-001', 'VID-002', 'VID-003', 'VID-004', 'VID-005', 'VID-006', 'VID-007', 'VID-008'];

// ---------------------------------------------------------------------------
// §23 — CTA callouts carried a literal "CTA:" content-library label into
// reader-facing body text. The underlying phrase is legitimate and stays;
// only the internal label is removed and the phrasing turned into a natural
// reader sentence. No route is hard-coded (§23 explicitly forbids that).
// ---------------------------------------------------------------------------
const CTA_REWRITE: Record<string, string> = {
  'Check My Financial Health': 'Check your financial health in FHIP.',
  'Check My Retirement Readiness': 'Check your retirement readiness in FHIP.',
  'Review My Investments': 'Review your investments in FHIP.',
  'View My Financial Health Score': 'View your Financial Health Score in FHIP.',
  'Review My Cash Flow': 'Review your cash flow in FHIP.',
  'Check My Financial Resilience': 'Check your financial resilience in FHIP.',
  'See My Net Worth': 'See your net worth in FHIP.',
  'Review My Debt Position': 'Review your debt position in FHIP.',
  'Review My Goals': 'Review your goals in FHIP.',
  'Explore My Forecast': 'Explore your forecast in FHIP.',
  'Review My Protection': 'Review your protection in FHIP.',
  'View My Consolidated Financial Position': 'View your consolidated financial position in FHIP.',
  'Open My Report': 'Open your report in FHIP.',
  'Open My Premium Report': 'Open your Premium Report in FHIP.',
  'Explore My Financial DNA': 'Explore your Financial DNA in FHIP.',
};

// ---------------------------------------------------------------------------
// §7 — reader-facing Sources must contain sources a reader can understand or
// access. These patterns identify bullets that cite internal FHIP
// engineering/QA/specification artifacts. They are replaced by one
// reader-appropriate line; the original text is preserved verbatim in the
// internal review register (see CorrectionResult.internal_references_preserved).
// ---------------------------------------------------------------------------
const INTERNAL_SOURCE_RE =
  /^(FHIP|Approved FHIP)\b.*?(specification|specifications|requirement|requirements|Engine|data dictionary|calculation-version|calculation version|methodology|methodologies|metric catalogue|reconciliation|test|QA|assertions|Proposal|Master Plan|Implementation Plan|Functional Requirements|governance|audit evidence|glossary meaning|architecture|controls|design|evidence|mapping|taxonomy|Explainer|Resources|expected dataset|examples)/i;

const READER_SOURCE_LINE =
  'FHIP methodology and calculation rules - the governed FHIP methodology, data definitions and calculation version used to produce the figures and metrics described here.';

// Trailing reviewer instructions appended to otherwise-legitimate external
// citations. The citation itself is reader-relevant and is kept; only the
// workflow instruction is trimmed.
const CITATION_TAIL_RULES: [RegExp, string][] = [
  [/,?\s*(current [^.;]*?)?\s*(rules )?to be checked (immediately |separately )?before publication\.?$/i, '.'],
  [/\s*to be checked on publication date\.?$/i, '.'],
  [/,?\s*to be selected and cited during editorial review\.?$/i, '.'],
  [/\s*-\s*authoritative (implementation source to verify |)before publication\.?$/i, '.'],
  [/,?\s*authoritative before publication\.?$/i, '.'],
  [/\s*-\s*final authority immediately before publication\.?$/i, '.'],
  [/\s*plus active calculation-version record - authoritative before publication\.?$/i, '.'],
];

// ---------------------------------------------------------------------------
// §8 — FHIP Explainer disclaimer. The closing sentence told a public reader
// the page "must be reconciled immediately before publication", which is an
// internal governance instruction and is self-contradicting once the page is
// live. Replaced with final reader-facing methodology-transparency wording.
// ---------------------------------------------------------------------------
const DISCLAIMER_RULES: [RegExp, string][] = [
  [
    /The current production calculation code, data dictionary,? (and )?(active calculation-version record|active calculation\/assumption version and relevant report template|active methodology\/assumption version and active report template) are authoritative and must be reconciled immediately before publication\./,
    'FHIP calculations are produced using the methodology, data definitions and calculation version active for the relevant report or assessment, and that active methodology remains the authoritative source. This explainer is kept aligned with it and is updated when the methodology changes.',
  ],
  [
    /The production calculation code, data dictionary and calculation-version record are authoritative\. This article must be revalidated before publication and updated immediately if the FHIP net-worth methodology, inclusion rules or currency treatment changes\./,
    'FHIP calculations are produced using the methodology, data definitions and calculation version active for the relevant report or assessment, and that active methodology remains the authoritative source. This explainer is kept aligned with it and is updated when the FHIP net-worth methodology, inclusion rules or currency treatment change.',
  ],
];

// ---------------------------------------------------------------------------
// §6 — targeted internal-instruction removals and rewordings, enumerated per
// record so every change is explicit and auditable rather than inferred.
// A `null` replacement means "delete this block entirely".
// ---------------------------------------------------------------------------
type TargetedEdit = { match: string; replace: string | null; classification: ChangeLogEntry['classification']; reason: string };

const TARGETED: Record<string, TargetedEdit[]> = {
  'EX-001': [
    {
      match: 'This explainer is product-dependent: it must be checked against current production code and calculation-version documentation immediately before publication.',
      replace: null,
      classification: 'INTERNAL_INSTRUCTION_REMOVE',
      reason: 'Reviewer instruction inside a reader-facing Key Takeaways list; the other four takeaways are genuine reader content and are retained.',
    },
    {
      match: 'Product-governance requirement before publication',
      replace: null,
      classification: 'INTERNAL_INSTRUCTION_REMOVE',
      reason: 'Section heading is an internal governance instruction, not reader information. Removed with its paragraphs.',
    },
    {
      match:
        'This Resource is a FHIP Explainer, so the product itself is the authority. Before publication, the editorial reviewer must compare this wording with the current production aggregation in the Dashboard/service engine, current data dictionary, calculation version and cross-module reconciliation tests.',
      replace: null,
      classification: 'INTERNAL_INSTRUCTION_REMOVE',
      reason: 'Directly addresses "the editorial reviewer" as an actor; pure workflow instruction.',
    },
    {
      match: 'If code or methodology changes, this Explainer must be updated immediately. Resource prose must never become a second, stale source of calculation truth.',
      replace: null,
      classification: 'INTERNAL_INSTRUCTION_REMOVE',
      reason: 'Internal content-governance rule addressed to the FHIP team, not the reader. The equivalent reader-facing assurance now lives in the rewritten disclaimer.',
    },
  ],
  'EX-003': [
    {
      match: 'The answer must follow the active production methodology. The current-state rate in the 50-user canonical dataset is based on monthly surplus divided by net income. Contributions must not be double counted.',
      replace: 'The answer follows the active FHIP methodology. The current-state rate is based on monthly surplus divided by net income, and contributions are not double counted.',
      classification: 'REWORD_FOR_PUBLIC_READER',
      reason: 'Cited an internal 50-user test dataset by name in a reader-facing FAQ answer. The methodology statement itself is reader-relevant and is retained.',
    },
  ],
  'EX-006': [
    {
      match:
        "Debt ratios are not globally standardised. Some lending or macroeconomic frameworks use gross income, disposable income or other definitions. FHIP's current 50-user canonical evidence uses net monthly income for DSR and the live Score language has described debt repayments as a share of net monthly income.",
      replace:
        "Debt ratios are not globally standardised. Some lending or macroeconomic frameworks use gross income, disposable income or other definitions. FHIP's current canonical definition uses net monthly income for debt service, and FHIP describes debt repayments as a share of net monthly income wherever the measure appears.",
      classification: 'REWORD_FOR_PUBLIC_READER',
      reason: 'Cited an internal test dataset by name. The underlying denominator statement is reader-relevant and is retained unchanged in substance.',
    },
    {
      match:
        'Older project artifacts may contain a gross-income DSR convention. That historical inconsistency is precisely why this Explainer is product-dependent: before publication, compare the draft with the current production code and active calculation version. If production differs, resolve the methodology rather than publishing two formulas.',
      replace: 'Because conventions differ, FHIP publishes one definition and applies it consistently. Where you see a debt-service figure elsewhere that uses a different income base, compare the formulas before comparing the percentages.',
      classification: 'REWORD_FOR_PUBLIC_READER',
      reason: 'Internal reconciliation instruction referencing "older project artifacts" and telling a reviewer what to do before publication. Replaced with the reader-relevant point it was protecting.',
    },
    {
      match: 'The current canonical FHIP household metric uses net monthly income to show repayment pressure against usable income. Publication must still be verified against the live calculation service.',
      replace: 'The current canonical FHIP household metric uses net monthly income to show repayment pressure against usable income.',
      classification: 'INTERNAL_INSTRUCTION_REMOVE',
      reason: 'Second sentence is a publication-workflow instruction embedded inside an FAQ answer.',
    },
  ],
  'EX-008': [
    {
      match: 'Only if the Product Owner chooses to and the values are verified against the current production score engine and active methodology version.',
      replace: 'Only where FHIP chooses to disclose them and the values have been confirmed against the active score methodology. This explainer deliberately does not publish a weight table.',
      classification: 'REWORD_FOR_PUBLIC_READER',
      reason: 'Named an internal actor ("the Product Owner") in a reader-facing FAQ answer. The substantive answer is preserved.',
    },
  ],
  'EX-025': [
    {
      match: 'The exact page count and layout can evolve, so this Resource must be checked against the active Free Report template immediately before publication.',
      replace: 'The exact page count and layout can evolve, so treat the sequence below as the reading order rather than a fixed page map.',
      classification: 'REWORD_FOR_PUBLIC_READER',
      reason: 'Reviewer instruction embedded in the opening answer. The reader-relevant caveat (layout can change) is preserved.',
    },
  ],
  'RAU-001': [
    {
      match: 'Current-rule snapshot - verify again before publication',
      replace: 'Current-rule snapshot',
      classification: 'REWORD_FOR_PUBLIC_READER',
      reason: 'Heading carried a publication-workflow instruction. The snapshot itself is legitimate reader content.',
    },
    {
      match: 'Tax, contribution caps and Age Pension eligibility are current-rule matters and must be checked separately.',
      replace: 'Tax, contribution caps and Age Pension eligibility are current-rule matters - check the current ATO and Services Australia information that applies to you.',
      classification: 'REWORD_FOR_PUBLIC_READER',
      reason: 'Legitimate reader caution, but "checked separately" read as an internal review note. Reworded to tell the reader where to check.',
    },
  ],
  'RIN-003': [
    {
      match: 'Current eligibility, withdrawal and exit rules have changed over time and must be verified before publication or action.',
      replace: 'Current eligibility, withdrawal and exit rules have changed over time - check current PFRDA guidance before acting.',
      classification: 'REWORD_FOR_PUBLIC_READER',
      reason: 'Reader-facing Key Takeaway containing a publication-workflow instruction. The underlying caution is genuine and is retained in reader form.',
    },
    {
      match: 'These eligibility details are current-rule statements, not permanent facts. They should be checked again before publication because NPS regulations and model eligibility can be amended.',
      replace: 'These eligibility details are current-rule statements, not permanent facts. Check them against current PFRDA guidance, because NPS regulations and model eligibility can be amended.',
      classification: 'REWORD_FOR_PUBLIC_READER',
      reason: 'Same caution, reworded from a publication instruction into reader guidance.',
    },
    {
      match:
        "Because these rules are detailed and have changed, this beginner Resource should not hard-code a simplified 'X% must always be annuitised' statement as if it were timeless. Before publication, the compliance reviewer should verify the latest PFRDA exit table and any sector-specific differences.",
      replace:
        "Because these rules are detailed and have changed, this introduction deliberately does not state a fixed 'X% must always be annuitised' figure as if it were permanent. The proportion that must be used for an annuity depends on the exit type, the subscriber's sector and the rules in force at the time, so check the current PFRDA exit provisions that apply to you.",
      classification: 'REWORD_FOR_PUBLIC_READER',
      reason: 'Directly addressed "the compliance reviewer". Reworded to explain to the reader why no fixed figure is given and where to check - which is the genuinely useful reader information.',
    },
  ],
  'MM-004': [
    {
      match: 'The published guide should therefore link to the approved "How FHIP Calculates Savings Rate" explainer once that explainer has been validated against production logic.',
      replace: 'For the in-app figure, see the FHIP Explainer "How FHIP Calculates Savings Rate".',
      classification: 'REWORD_FOR_PUBLIC_READER',
      reason: 'Content-workflow instruction ("once that explainer has been validated") in reader-facing body text.',
    },
    {
      match: 'The published guide should therefore link to the approved “How FHIP Calculates Savings Rate” explainer once that explainer has been validated against production logic.',
      replace: 'For the in-app figure, see the FHIP Explainer “How FHIP Calculates Savings Rate”.',
      classification: 'REWORD_FOR_PUBLIC_READER',
      reason: 'Content-workflow instruction ("once that explainer has been validated") in reader-facing body text (curly-quote variant).',
    },
  ],
  'IN-001': [
    {
      match: 'R1.7B content should educate users about the trade-off without turning FHIP into a product-selection adviser.',
      replace: 'FHIP Resources explain the trade-off without turning FHIP into a product-selection adviser.',
      classification: 'INTERNAL_INSTRUCTION_REMOVE',
      reason: 'Leaked an internal delivery-phase code ("R1.7B") into public body text. Found by full-text reading; not matched by pattern sweeps.',
    },
  ],
  'DN-001': [
    {
      match: 'Peer-reviewed behavioural-finance literature on present bias, inertia, loss aversion and decision heuristics, to be selected and cited during editorial review.',
      replace: 'Established behavioural-economics research on present bias, inertia, loss aversion and decision heuristics, as summarised in the OECD and CFPB publications listed above.',
      classification: 'REWORD_FOR_PUBLIC_READER',
      reason: 'Placeholder citation that both leaked a workflow instruction and promised sources that were never selected. Replaced with an accurate statement pointing at the real, listed publications rather than implying further uncited references exist.',
    },
  ],
  // §19 — EX-026 must describe the Premium Report as it works today, verified
  // against lib/engines/reportSectionsPremium.ts and lib/engines/reportSections.ts.
  'EX-026': [
    {
      match: 'The report may be about 16-22 pages for a standard household under the current V3 design direction, but the active production template is authoritative and the length should change when sections are not relevant.',
      replace: 'The report has no fixed length: sections that are not relevant to your household are omitted or replaced with a clear explanation, so the report is shorter or longer depending on what data you have recorded.',
      classification: 'REWORD_FOR_PUBLIC_READER',
      reason: 'The "16-22 page" target and "V3 design direction" come from a proposal document. The implemented report has no page-count concept at all; section inclusion is decided per household. Verified against reportSectionsPremium.ts.',
    },
    {
      match:
        'The current V3 design direction places the household story near the front: a short executive review, headline metrics, key strengths, areas requiring attention and the highest-priority next actions. This is the map for the rest of the report.',
      replace:
        'The report opens with an Executive Financial Summary: a short plain-English assessment, headline metrics, key strengths and the areas requiring attention. This is the map for the rest of the report. The ranked action plan is a separate section later in the report, once the supporting evidence has been presented.',
      classification: 'REWORD_FOR_PUBLIC_READER',
      reason:
        'The executive summary genuinely exists and is section 1, but it does not contain next actions - the Personal Action Plan is a late section. Corrected to the implemented structure and de-branded from "V3 design direction". Verified against reportSections.ts (buildExecutiveSummary, displayOrder 1) and reportSectionsPremium.ts (buildPersonalActionPlan, displayOrder 26).',
    },
    {
      match:
        'The V3 direction is to rank a small number of actions by importance and show why each matters, the evidence behind it, the gap or issue, expected direction of impact and a review timeframe. Where useful, actions can be sequenced across the next 30, 90 and 365 days.',
      replace:
        'The action plan ranks a small number of items by priority and shows, for each, the gap identified, the current and target values behind that gap where available, and where in FHIP to go to review it. It reflects the recommendations current as at the report date and does not track completion.',
      classification: 'REWORD_FOR_PUBLIC_READER',
      reason:
        'The implemented plan ranks the top five items by priority with gap, current/target values and a review step. It does not model "expected direction of impact" and there is no 30/90/365-day sequencing. Verified against buildPersonalActionPlan in reportSectionsPremium.ts.',
    },
    {
      match: 'This is the core Premium Report principle: calculation engine decides what is true; rule engine decides what matters; narrative library decides how to explain it; report composer decides where it appears.',
      replace:
        'This is the core Premium Report principle: the calculation engines decide what is true, and the report presents and explains those results. The report never recalculates a metric of its own - every figure comes from the same Health Score, Financial DNA, Financial Twin, Forecasting and Resilience calculations used elsewhere in FHIP.',
      classification: 'REWORD_FOR_PUBLIC_READER',
      reason:
        'The four-engine "narrative library / report composer" architecture is proposal vocabulary; no such components exist. The genuine and verifiable principle - that the report is a presentation layer that never recalculates - is stated instead. Verified against the reportSectionsPremium.ts header ("nothing here recalculates anything").',
    },
    {
      match: 'The current V3 direction does not require generative AI. Verified calculations, rules and governed narrative components can create the report. AI can be a future explanation layer only if safely grounded.',
      replace: 'The report does not use generative AI. Every figure and every explanation comes from verified calculations and governed content. If an AI-assisted explanation layer is ever introduced, it would sit on top of those verified results rather than replacing them.',
      classification: 'REWORD_FOR_PUBLIC_READER',
      reason: 'De-branded from "V3 direction" and changed from a design intention to a statement of what the shipped report actually does, with the future possibility clearly labelled as not current.',
    },
    {
      match:
        'FHIP Premium Report V3 Advisor-Style Redesign and Storytelling Library Proposal - report philosophy, 16-22 page target, storytelling architecture, page-by-page direction and deterministic narrative engine.',
      replace: null,
      classification: 'INTERNAL_INSTRUCTION_REMOVE',
      reason: 'Cited an internal, unimplemented proposal document as a source for current behaviour. This was the root cause of the inaccurate claims corrected above.',
    },
    {
      match: 'FHIP UX Redesign Master Plan - Free vs Premium report experience, document-like reading mode, guided Premium configuration and canonical-data principle.',
      replace: null,
      classification: 'INTERNAL_INSTRUCTION_REMOVE',
      reason: 'Internal design-planning document cited as a public source for current behaviour.',
    },
  ],
};

// ---------------------------------------------------------------------------
// §21 — video records. The R1.7C staging callout is an operator instruction
// and must not sit in public-facing content. It had also been written into
// `excerpt` and `seo_description`, which are the listing summary and the
// page meta description - a materially more exposed surface than the body
// callout Stage A flagged. Full scripts are left completely intact.
// ---------------------------------------------------------------------------
const VIDEO_STAGING_TEXT = 'Script and transcript draft complete. YouTube is the source of truth.';

/** Reader-facing summaries derived from each script's own production brief. */
const VIDEO_SUMMARY: Record<string, string> = {
  'VID-001': 'What financial health actually means: the ability to manage today, absorb a financial shock, build strength and keep making progress - and why salary alone does not answer the question.',
  'VID-002': 'The seven household numbers worth knowing: net income, monthly outflows, cash-flow surplus, savings rate, emergency-fund months, debt position and net worth - and what each one answers.',
  'VID-003': 'Net worth explained: included assets minus included liabilities, a worked balance-sheet example, and why net worth is different from both income and available cash.',
  'VID-004': 'Savings rate explained: the share of usable income left after included outflows, a transparent worked example, and why one strong month does not make a trend.',
  'VID-005': 'How much emergency fund you really need: measuring the buffer in months of essential expenses, and why the right amount depends on your household rather than a single rule.',
  'VID-006': "Debt-to-income explained: FHIP's balance-based measure of total liabilities against gross annual income, why DTI definitions differ, and how it differs from debt service.",
  'VID-007': 'Financial resilience explained: how liquidity, income stability, fixed commitments and protection together determine whether your finances can absorb a shock.',
  'VID-008': 'Compounding explained visually: how growth applies to a base that keeps changing, why time and contributions matter, and how compounding can work against you on debt.',
};

// ---------------------------------------------------------------------------

function blockText(b: Block): string {
  const d = b.data ?? {};
  return typeof d.text === 'string' ? d.text : '';
}

function isSourcesList(blocks: Block[], idx: number): boolean {
  // A Sources/reference bulleted_list is the one immediately preceded by a
  // heading whose text names it.
  for (let i = idx - 1; i >= 0 && i >= idx - 2; i--) {
    if (blocks[i].type === 'heading') {
      const t = blockText(blocks[i]).toLowerCase();
      return t.includes('source') || t.includes('reference basis');
    }
  }
  return false;
}

export function correctRecord(rec: RecordInput): CorrectionResult {
  const changes: ChangeLogEntry[] = [];
  const preserved: string[] = [];
  const cid = rec.content_id;
  let excerpt = rec.excerpt;
  let seoDescription = rec.seo_description;
  const out: Block[] = [];

  const log = (rule: string, clause: string, loc: string, cls: ChangeLogEntry['classification'], before: string, after: string, reason: string) =>
    changes.push({ content_id: cid, rule, spec_clause: clause, location: loc, classification: cls, before, after, reason });

  rec.content_blocks.forEach((b, i) => {
    const block: Block = { ...b, data: { ...(b.data ?? {}) } };
    let dropped = false;

    // --- §21 video staging callout + its heading -----------------------
    if (VIDEOS.includes(cid)) {
      if (typeof block.data.text === 'string' && (block.data.text as string).startsWith(VIDEO_STAGING_TEXT)) {
        log('video_staging_callout', '§21', `content_blocks[${i}] (${block.type})`, 'INTERNAL_INSTRUCTION_REMOVE', block.data.text as string, '(block removed)', 'Internal R1.7C staging instruction addressed to an operator ("Do not create a fake YouTube ID..."). Removed from public content; the non-fabrication rule itself is enforced by this pass and by resource_videos remaining empty.');
        dropped = true;
      } else if (block.type === 'heading' && blockText(block).trim() === 'Production status') {
        log('video_staging_callout', '§21', `content_blocks[${i}] (heading)`, 'INTERNAL_INSTRUCTION_REMOVE', 'Production status', '(block removed)', 'Heading paired with the removed staging callout; would otherwise leave an empty internal-only section.');
        dropped = true;
      }
    }

    if (dropped) return;

    // --- §6 targeted, enumerated edits ---------------------------------
    for (const edit of TARGETED[cid] ?? []) {
      // Text-bearing blocks
      if (typeof block.data.text === 'string') {
        const t = block.data.text as string;
        if (t.trim() === edit.match.trim()) {
          if (edit.replace === null) {
            log('targeted_edit', '§6', `content_blocks[${i}] (${block.type})`, edit.classification, t, '(block removed)', edit.reason);
            dropped = true;
          } else {
            log('targeted_edit', '§6', `content_blocks[${i}] (${block.type})`, edit.classification, t, edit.replace, edit.reason);
            block.data.text = edit.replace;
          }
          break;
        }
        if (t.includes(edit.match) && edit.replace !== null) {
          const after = t.replace(edit.match, edit.replace);
          log('targeted_edit', '§6', `content_blocks[${i}] (${block.type})`, edit.classification, t, after, edit.reason);
          block.data.text = after;
          break;
        }
      }
      // List-item blocks
      if (Array.isArray(block.data.items)) {
        const items = block.data.items as string[];
        const hit = items.findIndex((x) => x.trim() === edit.match.trim());
        if (hit >= 0) {
          const before = items[hit];
          const next = [...items];
          if (edit.replace === null) next.splice(hit, 1);
          else next[hit] = edit.replace;
          log('targeted_edit', '§6', `content_blocks[${i}] (${block.type}) item ${hit}`, edit.classification, before, edit.replace ?? '(item removed)', edit.reason);
          block.data.items = next;
          break;
        }
      }
    }

    if (dropped) return;

    // --- §7 internal-flavoured section headings ------------------------
    // "Editorial reference basis" names an internal editorial process, not
    // something a reader is looking for. The section itself is legitimate
    // transparency, so only the heading is reworded.
    if (block.type === 'heading' && blockText(block).trim() === 'Editorial reference basis') {
      log('reference_heading', '§7', `content_blocks[${i}] (heading)`, 'REWORD_FOR_PUBLIC_READER', 'Editorial reference basis', 'Reference basis', 'Heading described an internal editorial process. The section is legitimate reader-facing transparency, so only the heading is reworded.');
      block.data.text = 'Reference basis';
    }

    // --- §8 FHIP Explainer disclaimer ----------------------------------
    if (FHIP_EXPLAINERS.includes(cid) && block.type === 'warning' && typeof block.data.text === 'string') {
      for (const [re, rep] of DISCLAIMER_RULES) {
        const t = block.data.text as string;
        if (re.test(t)) {
          const after = t.replace(re, rep);
          log('explainer_disclaimer', '§8', `content_blocks[${i}] (warning)`, 'REWORD_FOR_PUBLIC_READER', t, after, 'Disclaimer told a public reader the page "must be reconciled immediately before publication" - an internal governance instruction that is self-contradicting on a live page. Replaced with final reader-facing methodology-transparency wording.');
          block.data.text = after;
          break;
        }
      }
    }

    // --- §23 CTA content-library label ---------------------------------
    if (typeof block.data.text === 'string') {
      const m = /^\s*CTA:\s*(.+?)\s*\.?\s*$/.exec(block.data.text as string);
      if (m) {
        const key = m[1].replace(/\.$/, '').trim();
        const rewrite = CTA_REWRITE[key];
        if (rewrite) {
          log('cta_label', '§23', `content_blocks[${i}] (${block.type})`, 'REWORD_FOR_PUBLIC_READER', block.data.text as string, rewrite, 'Literal "CTA:" content-library label was rendering in reader-facing body text. Label removed and the phrase turned into a natural reader sentence; no route is hard-coded (resource_ctas remains 0).');
          block.data.text = rewrite;
        }
      }
    }

    // --- §7 public-facing source policy --------------------------------
    if (block.type === 'bulleted_list' && Array.isArray(block.data.items) && isSourcesList(rec.content_blocks, i)) {
      const items = block.data.items as string[];
      const kept: string[] = [];
      const removedInternal: string[] = [];
      let addedReaderLine = false;

      for (const raw of items) {
        // The reader-facing replacement line is itself FHIP-prefixed, so it
        // must be exempted or a re-run would "re-correct" it and log a
        // phantom change (functionally a no-op, but misleading evidence).
        if (raw.trim() === READER_SOURCE_LINE) {
          kept.push(raw);
          addedReaderLine = true;
          continue;
        }
        if (INTERNAL_SOURCE_RE.test(raw.trim())) {
          removedInternal.push(raw);
          if (!addedReaderLine) {
            kept.push(READER_SOURCE_LINE);
            addedReaderLine = true;
          }
          continue;
        }
        // Trim reviewer instructions appended to real external citations.
        let line = raw;
        for (const [re, rep] of CITATION_TAIL_RULES) {
          if (re.test(line)) {
            const after = line.replace(re, rep).replace(/\s+\./, '.').replace(/\.\.+$/, '.');
            log('citation_tail', '§6', `content_blocks[${i}] (Sources item)`, 'INTERNAL_INSTRUCTION_REMOVE', line, after, 'Reviewer instruction appended to a legitimate external citation. The citation is kept; the workflow clause is trimmed.');
            line = after;
          }
        }
        kept.push(line);
      }

      if (removedInternal.length > 0) {
        preserved.push(...removedInternal.map((x) => `${cid}: ${x}`));
        log(
          'internal_source_policy',
          '§7',
          `content_blocks[${i}] (Sources)`,
          'INTERNAL_INSTRUCTION_MOVE_TO_METADATA',
          removedInternal.join(' || '),
          READER_SOURCE_LINE,
          'Sources cited internal FHIP engineering, QA, test-pack and specification artifacts that a public reader cannot access or understand. Replaced by one reader-appropriate methodology line; the precise internal references are preserved verbatim in the internal review register.',
        );
      }
      if (kept.length !== items.length || kept.some((x, k) => x !== items[k])) {
        block.data.items = kept;
      }
    }

    out.push(block);
  });

  // --- §21 video excerpt / meta description ----------------------------
  if (VIDEOS.includes(cid)) {
    if (typeof excerpt === 'string' && excerpt.startsWith(VIDEO_STAGING_TEXT)) {
      const after = VIDEO_SUMMARY[cid];
      log('video_excerpt', '§21', 'excerpt', 'INTERNAL_INSTRUCTION_REMOVE', excerpt, after, 'The internal staging instruction was the record\'s public excerpt - the listing-card summary. Replaced with a real reader-facing summary derived from the script\'s own production brief. Not detected by Stage A, which reviewed only the body callout.');
      excerpt = after;
    }
    if (typeof seoDescription === 'string' && seoDescription.startsWith(VIDEO_STAGING_TEXT)) {
      const after = VIDEO_SUMMARY[cid].slice(0, 300);
      log('video_seo_description', '§21', 'seo_description', 'INTERNAL_INSTRUCTION_REMOVE', seoDescription, after, 'The internal staging instruction was the record\'s meta description, the most externally-visible field of all. Replaced with a real reader-facing summary. Not detected by Stage A.');
      seoDescription = after;
    }
  }

  return {
    content_id: cid,
    changed: changes.length > 0,
    excerpt,
    seo_description: seoDescription,
    content_blocks: out,
    changes,
    internal_references_preserved: preserved,
  };
}
