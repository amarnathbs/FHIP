// Browser entry of the PDF layout check (scripts/nav2_pdf_layout_check.ts): renders the SAME print document component the print route renders.
import { createRoot } from 'react-dom/client';
import FundAnalyticsPrintDocument from '@/components/reports/FundAnalyticsPrintDocument';

const w = window as unknown as { __REPORT__: never; __VERSION__: { versionNumber: number; createdAt: string } | undefined };
const el = document.getElementById('root');
if (el) createRoot(el).render(<FundAnalyticsPrintDocument report={w.__REPORT__} version={w.__VERSION__} />);
