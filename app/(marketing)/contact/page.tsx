import type { Metadata } from 'next';
import Link from 'next/link';
import { ContactForm } from '@/components/marketing/ContactForm';

export const metadata: Metadata = {
  title: 'Contact — FHIP',
};

// Public "Contact" page linked from the landing page footer
// (components/marketing/LandingPage.tsx), previously a dead "#" placeholder.
// Deliberately shows no phone number, address, or email address on the page
// itself — only the form. Submissions post to app/api/contact/route.ts,
// which stores them in contact_submissions and emails a notification.
export default function ContactPage() {
  return (
    <div className="mx-auto max-w-xl px-6 py-16 text-gray-800">
      <h1 className="text-3xl font-semibold text-trust">Contact us</h1>
      <p className="mt-2 text-gray-600">
        Have a question, feedback, or found something that doesn&apos;t look right? Send us a message below and
        we&apos;ll get back to you.
      </p>

      <div className="mt-8">
        <ContactForm />
      </div>

      <p className="mt-8 text-sm text-gray-500">
        <Link href="/" className="text-trust underline">
          Back to home
        </Link>
      </p>
    </div>
  );
}
