'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';

interface ScenarioOption {
  id: string;
  scenario_name: string;
  scenario_type: string;
}

export function ScenarioSwitcher({ scenarios, activeScenarioId }: { scenarios: ScenarioOption[]; activeScenarioId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function onChange(scenarioId: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('scenario', scenarioId);
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-gray-500" htmlFor="forecast-scenario-select">
        Scenario
      </label>
      <select
        id="forecast-scenario-select"
        data-testid="forecast-scenario-selector"
        value={activeScenarioId}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border px-3 py-2 text-sm"
      >
        {scenarios.map((s) => (
          <option key={s.id} value={s.id}>
            {s.scenario_name} ({s.scenario_type})
          </option>
        ))}
      </select>
    </div>
  );
}
