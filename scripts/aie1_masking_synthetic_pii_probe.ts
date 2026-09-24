// AIE-1 final production completion (2026-09-25) -- local masking probe with
// SYNTHETIC PII only (no real person, no real document). Prints, per planted
// value, whether it survives `maskText` -- i.e. whether it would reach
// OpenAI on the request path -- and whether the gateway's own pre-egress
// re-scan (`containsUnmaskedPii`) would catch the survivor.
//
// Run: npx tsx scripts/aie1_masking_synthetic_pii_probe.ts
import { randomBytes } from 'node:crypto';

process.env.AIE_MASK_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('hex');

async function main() {
  const { maskText, containsUnmaskedPii } = await import('../lib/aie/masking/piiMasking');

  // Every value below is invented for this probe.
  const planted: Array<{ label: string; value: string }> = [
    { label: 'bare Name: label', value: 'Zelda Quarrington' },
    { label: 'Employee Name: label', value: 'Orson Vellacott' },
    { label: 'Account Name: label', value: 'Pemberly Nutt' },
    { label: 'Employee ID', value: 'EMP-448821' },
    { label: 'AU TFN', value: '123 456 782' },
    { label: 'AU mobile', value: '0412 555 019' },
    { label: 'AU landline', value: '(02) 9555 0199' },
    { label: 'email', value: 'zelda.q@example.invalid' },
    { label: 'BSB + account', value: '062-000 12345678' },
    { label: 'labelled address', value: '12 Imaginary Lane, Nowhere NSW 2999' },
    { label: 'unlabelled address line', value: '77 Fictional Parade, Elsewhere VIC 3999' },
    { label: 'date of birth', value: '14/02/1985' },
    { label: 'Medicare number', value: '2123 45670 1' },
    { label: 'IN PAN', value: 'ABCDE1234F' },
    { label: 'IN Aadhaar', value: '2345 6789 0123' },
    { label: 'IN UAN', value: '100987654321' },
  ];

  const text = [
    'PAYSLIP -- Synthetic Holdings Pty Ltd (fictional employer)',
    `Name: ${planted[0].value}`,
    `Employee Name: ${planted[1].value}`,
    `Account Name: ${planted[2].value}`,
    `Employee ID: ${planted[3].value}`,
    `Tax File Number: ${planted[4].value}`,
    `Mobile: ${planted[5].value}`,
    `Phone: ${planted[6].value}`,
    `Email: ${planted[7].value}`,
    `Paid to BSB/Account: ${planted[8].value}`,
    `Address: ${planted[9].value}`,
    planted[10].value,
    `Date of Birth: ${planted[11].value}`,
    `Medicare: ${planted[12].value}`,
    `PAN: ${planted[13].value}`,
    `Aadhaar: ${planted[14].value}`,
    `UAN: ${planted[15].value}`,
    'Pay Period: 01/08/2026 - 14/08/2026   Payment Date: 15/08/2026',
    'Gross Pay 3200.00   Tax 512.00   Net Pay 2488.00',
  ].join('\n');

  const masked = maskText(text, { tenantKey: 'synthetic-tenant-aie1-final' });
  let survivors = 0;
  for (const p of planted) {
    const survived = masked.maskedText.includes(p.value);
    if (survived) survivors++;
    console.log(`${survived ? 'SURVIVES' : 'masked  '}  ${p.label}`);
  }
  console.log(`\n${survivors} of ${planted.length} planted values survive maskText`);
  console.log(`gateway pre-egress re-scan flags the masked text as still containing PII: ${containsUnmaskedPii(masked.maskedText)}`);
  console.log(`money/date facts preserved for extraction: ${masked.maskedText.includes('3200.00') && masked.maskedText.includes('2488.00')}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
