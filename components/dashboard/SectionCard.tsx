import { ContextualExplain } from '@/components/aiExplain/ContextualExplain';

export function SectionCard({
  title,
  description,
  children,
  className,
  explain,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
  className?: string;
  // Module 11.5 — an optional section-level Explain / Why? control, rendered
  // beside the section heading. Omitted by every pre-11.5 caller (a
  // zero-behaviour-change addition), and ContextualExplain itself renders
  // nothing when the feature switch is off or the target is not enabled.
  //
  // LAYOUT STABILITY (spec section 70): the heading row becomes a flex row
  // only when an explain slot is supplied; without one the markup is
  // byte-identical to before, so no existing section can shift.
  explain?: { targetCode: string; accessibleLabel: string; targetId?: string | null; contextId?: string | null };
}) {
  return (
    <section className={`rounded-card border border-line bg-white p-6${className ? ` ${className}` : ''}`}>
      {explain ? (
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <h2 className="text-lg font-semibold text-ink">{title}</h2>
          <ContextualExplain
            targetCode={explain.targetCode}
            targetId={explain.targetId}
            contextId={explain.contextId}
            accessibleLabel={explain.accessibleLabel}
            className="inline-flex min-h-[32px] items-center gap-1 text-xs font-medium text-ai hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ai focus-visible:ring-offset-1"
          />
        </div>
      ) : (
        <h2 className="text-lg font-semibold text-ink">{title}</h2>
      )}
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className="text-lg font-semibold tabular-nums text-ink">{value}</p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </div>
  );
}
