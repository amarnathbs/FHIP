'use client';

// G4 closure item 2 (Product Owner, 2026-09-05): a small client hook so a
// module's own page/panel components can ask "can I show a live create/edit
// control for this module right now?" without each one re-implementing the
// fetch/parse dance. Reuses the EXACT SAME endpoint and fail-closed parsing
// convention components/ui/AppShell.tsx already established for nav
// visibility (GET /api/capabilities/nav, parseNavDecisions) — this hook adds
// nothing new architecturally, it just reads the endpoint's sibling
// `writeDecisions` field via parseWriteDecisions()/isModuleWriteAvailable().
//
// Fails closed the same way the nav filter does: while the fetch is
// in-flight, or if it fails or returns a malformed body, `available` stays
// false — a page must never default to showing a writable control before it
// has proof the write is actually safe. `resolved` distinguishes "still
// loading" from "resolved and unavailable" so a consumer can choose to show
// nothing (rather than a locked-state flash) during the brief initial fetch.
import { useEffect, useState } from 'react';
import type { ModuleKey } from '@/lib/services/appCapability';
import { parseWriteDecisions, isModuleWriteAvailable } from '@/lib/nav/appNavCapability';

export function useModuleWriteAvailability(moduleKey: ModuleKey): { available: boolean; resolved: boolean } {
  const [available, setAvailable] = useState(false);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/capabilities/nav')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return;
        setAvailable(isModuleWriteAvailable(moduleKey, parseWriteDecisions(j)));
        setResolved(true);
      })
      .catch(() => {
        if (cancelled) return;
        setAvailable(false);
        setResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [moduleKey]);

  return { available, resolved };
}
