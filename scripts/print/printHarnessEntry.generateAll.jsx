// Browser entry for the Fund analytics SCREEN (components/reports/FundAnalyticsReportClient.tsx): the REAL component, with window.fetch replaced by a scripted
// server (scripts/print/faGenerateAllScreenCheck.ts). No dev server, login or database.
import React from 'react';
import { createRoot } from 'react-dom/client';
import FundAnalyticsReportClient from '@/components/reports/FundAnalyticsReportClient';

createRoot(document.getElementById('root')).render(<FundAnalyticsReportClient />);
window.__READY__ = true;
