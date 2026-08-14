'use client';

import { useState, type FormEvent } from 'react';

type Status = 'idle' | 'submitting' | 'success' | 'error';

export function ContactForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  // Honeypot — kept out of the visible layout (not display:none, which some
  // bots skip past) and unreachable by keyboard/tab order. A real visitor
  // never sees or fills it; app/api/contact/route.ts treats a filled value
  // as a bot submission and reports success without sending anything.
  const [website, setWebsite] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setStatus('submitting');
    setErrorMessage(null);
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, message, website }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus('error');
        setErrorMessage(body?.error ?? 'Something went wrong. Please try again.');
        return;
      }
      setStatus('success');
      setName('');
      setEmail('');
      setMessage('');
    } catch {
      setStatus('error');
      setErrorMessage('Could not reach the server. Please check your connection and try again.');
    }
  }

  if (status === 'success') {
    return (
      <div className="rounded-card border border-line bg-white p-8 text-center">
        <p className="text-lg font-semibold text-trust">Message sent</p>
        <p className="mt-2 text-sm text-gray-600">
          Thanks for reaching out — we&apos;ve received your message and will get back to you soon.
        </p>
        <button
          type="button"
          onClick={() => setStatus('idle')}
          className="mt-4 text-sm font-medium text-trust underline"
        >
          Send another message
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-card border border-line bg-white p-8" noValidate>
      <div className="space-y-5">
        <div>
          <label htmlFor="contact-name" className="block text-sm font-medium text-gray-700">
            Name
          </label>
          <input
            id="contact-name"
            type="text"
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-trust focus:outline-none focus:ring-1 focus:ring-trust"
            disabled={status === 'submitting'}
          />
        </div>

        <div>
          <label htmlFor="contact-email" className="block text-sm font-medium text-gray-700">
            Email
          </label>
          <input
            id="contact-email"
            type="email"
            required
            maxLength={320}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-trust focus:outline-none focus:ring-1 focus:ring-trust"
            disabled={status === 'submitting'}
          />
        </div>

        <div>
          <label htmlFor="contact-message" className="block text-sm font-medium text-gray-700">
            Message
          </label>
          <textarea
            id="contact-message"
            required
            maxLength={5000}
            rows={6}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-trust focus:outline-none focus:ring-1 focus:ring-trust"
            disabled={status === 'submitting'}
          />
        </div>

        {/* Honeypot field — visually and structurally hidden from real users. */}
        <div aria-hidden="true" className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden">
          <label htmlFor="contact-website">Leave this field empty</label>
          <input
            id="contact-website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </div>

        {status === 'error' && errorMessage && (
          <p className="text-sm text-risk" role="alert">
            {errorMessage}
          </p>
        )}

        <button
          type="submit"
          disabled={status === 'submitting'}
          className="w-full rounded-md bg-trust px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-trust-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {status === 'submitting' ? 'Sending…' : 'Send message'}
        </button>
      </div>
    </form>
  );
}
