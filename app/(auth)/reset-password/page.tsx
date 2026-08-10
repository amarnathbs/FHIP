'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';

export default function ResetPasswordPage() {
  const router = useRouter();
  const supabase = createClient();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  // The reset-link email points here with a recovery token in the URL;
  // @supabase/ssr's browser client detects it automatically and fires this
  // event once a recovery session is established. Until that happens (or if
  // the link is expired/already used), there's no valid session to update
  // a password against.
  const [recoveryReady, setRecoveryReady] = useState(false);

  useEffect(() => {
    const { data: listener } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'PASSWORD_RECOVERY') {
        setRecoveryReady(true);
      }
    });
    // If the tab already processed the recovery token before this listener
    // was attached (e.g. fast page load), fall back to checking for a
    // session directly rather than requiring the event to fire.
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) setRecoveryReady(true);
    });
    return () => listener.subscription.unsubscribe();
  }, [supabase]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setSubmitting(true);
    const { error } = await supabase.auth.updateUser({ password });
    setSubmitting(false);
    if (error) {
      setError(error.message);
      return;
    }
    setDone(true);
  }

  if (done) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
        <h1 className="text-2xl font-semibold text-trust">Password updated</h1>
        <p className="mt-4 text-sm text-gray-600">Your password has been changed. Log in with your new password.</p>
        <Link
          href="/login"
          className="mt-6 block w-full rounded bg-trust px-4 py-2 text-center font-medium text-white"
        >
          Go to log in
        </Link>
      </div>
    );
  }

  if (!recoveryReady) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
        <h1 className="text-2xl font-semibold text-trust">Checking your reset link&hellip;</h1>
        <p className="mt-4 text-sm text-gray-600">
          If this doesn&apos;t update in a few seconds, the link may have expired or already been used.
        </p>
        <p className="mt-4 text-sm text-gray-500">
          <Link href="/forgot-password" className="text-trust underline">
            Request a new reset link
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold text-trust">Choose a new password</h1>
      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <div>
          <label htmlFor="password" className="block text-sm text-gray-600">New password</label>
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
        <div>
          <label htmlFor="confirmPassword" className="block text-sm text-gray-600">Confirm new password</label>
          <input
            id="confirmPassword"
            type="password"
            required
            minLength={8}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="mt-1 w-full rounded border px-3 py-2"
          />
        </div>
        {error && <p className="text-sm text-risk">{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-trust px-4 py-2 font-medium text-white disabled:opacity-60"
        >
          {submitting ? 'Updating...' : 'Update password'}
        </button>
      </form>
    </div>
  );
}
