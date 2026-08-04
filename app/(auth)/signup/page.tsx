'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';

export default function SignupPage() {
  const router = useRouter();
  const supabase = createClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmationSent, setConfirmationSent] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const { data, error } = await supabase.auth.signUp({ email, password });
    setSubmitting(false);
    if (error) {
      setError(error.message);
      return;
    }
    // A null session means email confirmation is required before the account
    // is usable — stay on this page and tell the user to check their inbox,
    // instead of navigating to a protected route that will just bounce them
    // to /login with no explanation.
    if (!data.session) {
      setConfirmationSent(true);
      return;
    }
    router.push('/onboarding');
    router.refresh();
  }

  if (confirmationSent) {
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
