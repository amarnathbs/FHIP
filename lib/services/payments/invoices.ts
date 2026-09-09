// LR-10 WP-08 — Receipts/invoices. Deliberately a thin passthrough over
// each provider's own generated invoice records: FHIP never computes a
// total, a tax line, or a receipt number of its own (WP-09 "no invented tax
// advice/figures" applies here too — a receipt is a legal-ish document, its
// numbers must be the provider's, verbatim).
import type Stripe from 'stripe';
import { getStripeClient } from '@/lib/services/payments/stripeClient';
import { getRazorpayClient } from '@/lib/services/payments/razorpayClient';

export interface BillingReceipt {
  id: string;
  issuedAt: string | null; // ISO timestamp, null if not yet issued
  amountFormatted: string; // e.g. "$9.99 AUD" — provider-reported, display-only
  status: string;
  url: string | null; // provider-hosted receipt/invoice page, or null if none yet
}

export async function listStripeReceipts(customerId: string): Promise<BillingReceipt[]> {
  const stripe = getStripeClient();
  if (!stripe) return [];
  const invoices = await stripe.invoices.list({ customer: customerId, limit: 12 });
  return invoices.data.map((inv: Stripe.Invoice) => ({
    id: inv.id ?? inv.number ?? 'unknown',
    issuedAt: inv.created ? new Date(inv.created * 1000).toISOString() : null,
    amountFormatted: formatMinorUnits(inv.amount_paid, inv.currency),
    status: inv.status ?? 'unknown',
    url: inv.hosted_invoice_url ?? inv.invoice_pdf ?? null,
  }));
}

export async function listRazorpayReceipts(subscriptionId: string): Promise<BillingReceipt[]> {
  const razorpay = getRazorpayClient();
  if (!razorpay) return [];
  const result = await razorpay.invoices.all({ subscription_id: subscriptionId, count: 12 });
  return result.items.map((inv) => ({
    id: inv.id,
    issuedAt: inv.issued_at ? new Date(inv.issued_at * 1000).toISOString() : null,
    amountFormatted: formatMinorUnits(inv.amount_paid ?? 0, inv.currency ?? 'INR'),
    status: inv.status ?? 'unknown',
    url: inv.short_url ?? null,
  }));
}

function formatMinorUnits(amountMinorUnits: number, currencyCode: string): string {
  const upper = currencyCode.toUpperCase();
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: upper }).format(amountMinorUnits / 100);
  } catch {
    return `${(amountMinorUnits / 100).toFixed(2)} ${upper}`;
  }
}
