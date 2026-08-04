import Link from 'next/link';

export default function LandingPage() {
  return (
    <div className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-6 text-center">
      <h1 className="text-4xl font-bold text-trust">Financial Health Intelligence Platform</h1>
      <p className="mt-4 text-lg text-gray-600">
        Understand your Financial Health Score, DNA, resilience and goals in one place.
      </p>
      <div className="mt-8 flex gap-4">
        <Link href="/signup" className="rounded bg-trust px-6 py-3 font-medium text-white">
          Get started
        </Link>
        <Link href="/login" className="rounded border px-6 py-3 font-medium text-gray-700">
          Log in
        </Link>
      </div>
    </div>
  );
}
