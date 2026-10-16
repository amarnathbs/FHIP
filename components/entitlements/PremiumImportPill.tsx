/**
 * The Premium marker on a locked Import control. Premium status is carried by the TEXT "Premium" (never by
 * colour alone); the violet `ai` token is the product's existing Premium / intelligence accent, not caution amber.
 */
export function PremiumImportPill({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border border-ai/40 bg-ai/10 px-2 py-0.5 text-xs font-semibold text-ai ${className}`}>
      <svg aria-hidden="true" focusable="false" viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="3" y="7" width="10" height="7" rx="1.5" />
        <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" strokeLinecap="round" />
      </svg>
      Premium
    </span>
  );
}
