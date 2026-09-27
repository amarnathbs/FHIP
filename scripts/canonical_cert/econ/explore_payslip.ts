/** Exploration: upload + process + approve + propose a synthetic payslip; print everything. */
import { uploadPayslip, approvePayslip } from './payslip_flow';

const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
async function main() {
  const email = arg('--email')!;
  const up = await uploadPayslip(email, { year: 2026, month: 8 }, arg('--salt') ?? 'B');
  console.log(JSON.stringify({ documentId: up.documentId, complete: up.complete, process: up.process, review: up.review }, null, 1).slice(0, 7000));
  if (args.includes('--approve')) {
    const ap = await approvePayslip(email, up.documentId);
    console.log(JSON.stringify(ap, null, 1).slice(0, 7000));
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
