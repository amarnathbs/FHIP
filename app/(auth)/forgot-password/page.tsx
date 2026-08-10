'use client';

import { useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';

export default function ForgotPasswordPage() {
  const supabase = createClient();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setSubmitting(false);
    // Supabase intentionally does not distinguish "no account with this
    // email" from success here (same anti-enumeration reasoning as
    // signUp's identities check) — a request error only means something
    // like a malformed email or a rate limit, not "email not found".
    if (error) {
      setError(error.message);
      return;
    }
    setSent(true);
  }

  if (sent) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
        <h1 className="text-2xl font-semibold text-trust">Check your email</h1>
        <p className="mt-4 text-sm text-gray-600">
          If an account exists for <span className="font-medium">{email}</span>, we&apos;ve sent a link to reset
          your password.
        </p>
        <p className="mt-4 text-sm text-gray-500">
          <Link href="/login" className="text-trust underline">
            Back to log in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold text-trust">Reset your password</h1>
      <p className="mt-2 text-sm text-gray-600">Enter your email and we&apos;ll send you a link to reset it.</p>
      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="email" className="block text-sm text-gray-600">Email</label>
          <input
            id="email"
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
          />
        </div>
        {error && <p className="text-sm text-risk">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-trust px-4 py-2 font-medium text-white disabled:opacity-60"
        >
          {submitting ? 'Sending...' : 'Send reset link'}
        </button>
      </form>
      <p className="mt-4 text-sm text-gray-500">
        <Link href="/login" className="text-trust underline">
          Back to log in
        </Link>
      </p>
    </div>
  );
}
