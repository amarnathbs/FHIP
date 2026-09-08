// LR-10 WP-12 — same activation-control discipline as stripeClient.ts.
import Razorpay from 'razorpay';

export type RazorpayUnavailableReason = 'NOT_CONFIGURED' | 'KEY_ENVIRONMENT_MISMATCH';

let cached: Razorpay | null = null;
let cachedKeyId: string | null = null;

function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === 'production';
}

/** Razorpay's own key-id prefix distinguishes test vs. live mode, exactly like Stripe's — documented in Razorpay's own API reference (rzp_test_.../rzp_live_...). */
function isLiveRazorpayKey(keyId: string): boolean {
  return keyId.startsWith('rzp_live_');
}

export function getRazorpayUnavailableReason(): RazorpayUnavailableReason | null {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return 'NOT_CONFIGURED';
  const live = isLiveRazorpayKey(keyId);
  if (live !== isProductionEnvironment()) return 'KEY_ENVIRONMENT_MISMATCH';
  return null;
}

export function getRazorpayClient(): Razorpay | null {
  if (getRazorpayUnavailableReason() !== null) return null;
  const keyId = process.env.RAZORPAY_KEY_ID!;
  const keySecret = process.env.RAZORPAY_KEY_SECRET!;
  if (cached && cachedKeyId === keyId) return cached;
  cached = new Razorpay({ key_id: keyId, key_secret: keySecret });
  cachedKeyId = keyId;
  return cached;
}
