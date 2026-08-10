'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { OAuthButtons } from '@/components/auth/OAuthButtons';

export default function SignupPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmationSent, setConfirmationSent] = useState(false);
  // Supabase silently no-ops signUp() for an email that already has an
  // account — no error, no new confirmation email, but also no session
  // (to avoid leaking which emails are registered via a distinct error
  // message). The documented way to tell the two cases apart client-side
  // is `data.user.identities` being an empty array on the no-op path
  // (see https://supabase.com/docs/reference/javascript/auth-signup —
  // "If a user has already registered..."). Without this check the UI
  // showed the same "Check your email" for both, which is exactly what
  // silently swallowed a real user's second signup attempt.
  const [possibleExistingAccount, setPossibleExistingAccount] = useState(false);
  const [resendState, setResendState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setResendState('idle');
    const { data, error } = await supabase.auth.signUp({ email, password });
    setSubmitting(false);
    if (error) {
      setError(error.message);
      return;
    }
    // A null session means either (a) a brand-new account was created and
    // needs email confirmation, or (b) this email already has an account
    // and Supabase deliberately sent nothing — distinguish via identities.
    if (!data.session) {
      setPossibleExistingAccount((data.user?.identities?.length ?? 1) === 0);
      setConfirmationSent(true);
      return;
    }
    router.push('/onboarding');
    router.refresh();
  }

  async function handleResend() {
    setResendState('sending');
    const { error } = await supabase.auth.resend({ type: 'signup', email });
    setResendState(error ? 'error' : 'sent');
  }

  if (confirmationSent) {
    if (possibleExistingAccount) {
      return (
        <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
          <h1 className="text-2xl font-semibold text-trust">Check your email — if this is new to you</h1>
          <p className="mt-4 text-sm text-gray-600">
            An account with <span className="font-medium">{email}</span> may already exist. If that&apos;s you,
            try logging in below, or reset your password if you don&apos;t remember it. If you signed up before
            but never confirmed your email, use the button below to resend the confirmation link.
          </p>
          <button
            type="button"
            onClick={handleResend}
            disabled={resendState === 'sending'}
            className="mt-4 w-full rounded border border-trust px-4 py-2 font-medium text-trust disabled:opacity-60"
          >
            {resendState === 'sending' ? 'Sending...' : 'Resend confirmation email'}
          </button>
          {resendState === 'sent' && (
            <p className="mt-2 text-sm text-progress">Confirmation email resent — check your inbox.</p>
          )}
          {resendState === 'error' && (
            <p className="mt-2 text-sm text-risk">Could not resend right now. Try again shortly.</p>
          )}
          <p className="mt-4 flex justify-between text-sm text-gray-500">
            <Link href="/login" className="text-trust underline">
              Go to log in
            </Link>
            <Link href="/forgot-password" className="text-trust underline">
              Reset password
            </Link>
          </p>
        </div>
      );
    }
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
        <h1 className="text-2xl font-semibold text-trust">Check your email</h1>
        <p className="mt-4 text-sm text-gray-600">
          We&apos;ve sent a confirmation link to <span className="font-medium">{email}</span>.
          Follow the link in that email to activate your account, then log in below.
        </p>
        <p className="mt-4 text-sm text-gray-500">
          <Link href="/login" className="text-trust underline">
            Go to log in
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold text-trust">Create your account</h1>
      <div className="mt-6">
        <OAuthButtons />
      </div>
      <form onSubmit={handleSubmit} className="space-y-4">
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
        <div>
          <label htmlFor="password" className="block text-sm text-gray-600">Password</label>
          <input
            id="password"
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
          />
        </div>
        {error && <p className="text-sm text-risk">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-trust px-4 py-2 font-medium text-white disabled:opacity-60"
        >
          {submitting ? 'Creating account...' : 'Sign up'}
        </button>
      </form>
      <p className="mt-4 text-sm text-gray-500">
        Already have an account?{' '}
        <Link href="/login" className="text-trust underline">
          Log in
        </Link>
      </p>
    </div>
  );
}
