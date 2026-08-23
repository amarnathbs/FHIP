/**
 * R7 -- Bank CSV Engine: independent oracle comparison harness (spec section
 * 65-66).
 *
 * Runs each fixture through:
 *   (a) the REAL production pipeline (`runBankCsvPipeline`, imported
 *       directly from `lib/financial-data-hub/bank-csv/orchestrator.ts`)
 *   (b) the INDEPENDENT Python oracle (`r7_independent_bank_csv_oracle.py`,
 *       which imports nothing from (a))
 * and diffs them field by field: row count, transaction date, amount, sign,
 * description, reference, balance, reconciliation result. Reports the total
 * number of atomic comparisons made and the number of discrepancies found.
 * Required: 0 unexplained discrepancies (spec 66).
 *
 * Run: npx tsx scripts/r7_oracle_compare.ts
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { runBankCsvPipeline } from '../lib/financial-data-hub/bank-csv/orchestrator';
import { adapterToRowFormat } from '../lib/financial-data-hub/bank-csv/normalize';
import { getAdapterById } from '../lib/financial-data-hub/bank-csv/adapters/registry';

const FIXTURES_DIR = path.resolve(__dirname, '../tests/fixtures/r7-bank-csv');

interface OracleAcceptedRow {
  row: number;
  date: string;
  description_raw: string;
  description_clean: string;
  reference: string | null;
  amount: string;
  direction: 'debit' | 'credit';
  balance_after: string | null;
}
interface OracleResult {
  fixture: string;
  declared_row_count: number;
  parsed_row_count: number;
  rejected_row_count: number;
  accepted: OracleAcceptedRow[];
  reconciliation: {
    status: string;
    extracted_credits: string;
    extracted_debits: string;
    opening_balance: string | null;
    expected_closing_balance: string | null;
    reported_closing_balance: string | null;
    variance: string | null;
  };
}

let totalComparisons = 0;
let totalFailures = 0;
const failures: string[] = [];

function compare(label: string, actual: unknown, expected: unknown) {
  totalComparisons += 1;
  const a = typeof actual === 'number' ? actual.toFixed(4) : String(actual);
  const e = typeof expected === 'number' ? expected.toFixed(4) : String(expected);
  if (a !== e) {
    totalFailures += 1;
    failures.push(`${label}: production=${a} oracle=${e}`);
  }
}

function runOracle(fixtureCsv: string, profileJson: string): OracleResult {
  const out = execFileSync('python', [
    path.resolve(__dirname, 'r7_independent_bank_csv_oracle.py'),
    fixtureCsv,
    profileJson,
  ]);
  return JSON.parse(out.toString('utf8'));
}

function main() {
  const profiles = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.profile.json'));
  console.log(`R7 independent oracle comparison — ${profiles.length} fixtures\n`);

  for (const profileFile of profiles) {
    const fixtureCsv = path.join(FIXTURES_DIR, profileFile.replace('.profile.json', '.csv'));
    const profilePath = path.join(FIXTURES_DIR, profileFile);
    const profile = JSON.parse(readFileSync(profilePath, 'utf8')) as { adapter_id: string };

    const oracle = runOracle(fixtureCsv, profilePath);

    const adapter = getAdapterById(profile.adapter_id);
    if (!adapter) throw new Error(`unknown adapter ${profile.adapter_id}`);
    const bytes = readFileSync(fixtureCsv);

    const pipeline = runBankCsvPipeline({
      bytes: new Uint8Array(bytes),
      statementUploadId: 'oracle-comparison',
      financialAccountId: 'oracle-account',
      currencyCode: 'AUD',
      rowFormatOverride: adapterToRowFormat(adapter),
      dedupIndex: new Map(),
    });

    console.log(`-- ${oracle.fixture} (adapter ${profile.adapter_id}) --`);
    compare(`${oracle.fixture} declared_row_count`, pipeline.declaredRowCount, oracle.declared_row_count);
    compare(`${oracle.fixture} parsed_row_count`, pipeline.parsedRowCount, oracle.parsed_row_count);
    compare(`${oracle.fixture} rejected_row_count`, pipeline.rejected.length, oracle.rejected_row_count);

    for (let i = 0; i < oracle.accepted.length; i++) {
      const oRow = oracle.accepted[i];
      const pRow = pipeline.accepted[i];
      if (!pRow) {
        totalFailures += 1;
        failures.push(`${oracle.fixture} row ${oRow.row}: production is missing this row entirely`);
        continue;
      }
      compare(`${oracle.fixture} row ${oRow.row} date`, pRow.transactionDate, oRow.date);
      compare(`${oracle.fixture} row ${oRow.row} amount`, pRow.amountOriginal, Number(oRow.amount));
      compare(`${oracle.fixture} row ${oRow.row} direction`, pRow.creditDebit, oRow.direction);
      compare(`${oracle.fixture} row ${oRow.row} description_clean`, pRow.descriptionClean, oRow.description_clean);
      compare(`${oracle.fixture} row ${oRow.row} reference`, pRow.referenceRaw ?? null, oRow.reference);
      if (oRow.balance_after !== null) {
        compare(`${oracle.fixture} row ${oRow.row} balance_after`, pRow.balanceAfter, Number(oRow.balance_after));
      } else {
        totalComparisons += 1;
        if (pRow.balanceAfter !== null) {
          totalFailures += 1;
          failures.push(`${oracle.fixture} row ${oRow.row} balance_after: production=${pRow.balanceAfter} oracle=null`);
        }
      }
    }

    compare(`${oracle.fixture} reconciliation status`, pipeline.reconciliation?.status ?? 'not_available', oracle.reconciliation.status);
    if (oracle.reconciliation.extracted_credits !== null) {
      compare(`${oracle.fixture} extracted_credits`, pipeline.reconciliation?.extractedCredits ?? 0, Number(oracle.reconciliation.extracted_credits));
      compare(`${oracle.fixture} extracted_debits`, pipeline.reconciliation?.extractedDebits ?? 0, Number(oracle.reconciliation.extracted_debits));
    }
    if (oracle.reconciliation.expected_closing_balance !== null) {
      compare(
        `${oracle.fixture} expected_closing_balance`,
        pipeline.reconciliation?.expectedClosingBalance ?? null,
        Number(oracle.reconciliation.expected_closing_balance),
      );
      compare(
        `${oracle.fixture} reported_closing_balance`,
        pipeline.reconciliation?.reportedClosingBalance ?? null,
        Number(oracle.reconciliation.reported_closing_balance),
      );
      compare(`${oracle.fixture} variance`, pipeline.reconciliation?.variance ?? null, Number(oracle.reconciliation.variance));
    }
  }

  console.log(`\nTotal comparisons: ${totalComparisons}`);
  console.log(`Total failures: ${totalFailures}`);
  if (failures.length > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log('\n0 unexplained discrepancies — independent oracle agrees with production on every comparison.');
  }
}

main();
