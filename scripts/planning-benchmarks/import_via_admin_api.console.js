// Planning Benchmarks first-load runner - paste into the browser DevTools console while signed in as an
// administrator on the target environment (DEV first). It uses ONLY the existing Admin API routes:
//   GET/POST /api/admin/benchmarks/sources | datasets | cohorts | values | target-ranges
// It adds no route, changes no application code, and carries no credentials (it uses your session cookie).
//
//   1. paste this whole file into the console;
//   2. await pbPickPayload()          -> choose first_load_payload.json (built by build_payloads.mjs)
//   3. await pbRunImport(payload)     -> DRY RUN by default: reads state, prints the plan, writes nothing
//   4. await pbRunImport(payload, { dryRun: false })  -> performs the writes, then downloads a log file
//                                        containing every created id and a rollback SQL script
//
// Safety: refuses to load a dataset that already has values (no unique key exists, a second run would
// duplicate every row); stops at the first failed write; never retries; never deletes.
(function () {
  const BASE = '/api/admin/benchmarks';

  async function pbPickPayload() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = async () => {
        try {
          const text = await input.files[0].text();
          resolve(JSON.parse(text));
        } catch (e) {
          reject(e);
        }
      };
      input.click();
    });
  }

  async function pbRunImport(payload, opts) {
    opts = opts || {};
    const dryRun = opts.dryRun !== false;
    const f = opts.fetch || ((u, o) => fetch(u, o));
    const log = opts.log || ((...a) => console.log(...a));
    const chunkSize = opts.chunkSize || 100;
    const download = opts.download || ((name, text) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      a.download = name;
      a.click();
    });

    if (!payload || payload.format !== 'fhip-planning-benchmarks-first-load/1') throw new Error('not a first-load payload');

    const created = { sources: [], datasets: [], cohorts: [], values: [], targetRanges: [] };
    const events = [];
    const note = (m) => {
      events.push(m);
      log(m);
    };

    async function getJson(path) {
      const res = await f(BASE + path, { method: 'GET', credentials: 'same-origin' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('GET ' + path + ' -> ' + res.status + ' ' + (json.error || ''));
      return json.data;
    }
    async function postJson(path, body) {
      const res = await f(BASE + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('POST ' + path + ' -> ' + res.status + ' ' + (json.error || '') + ' ' + (json.code || ''));
      return json.data;
    }

    // ---- read current state ---------------------------------------------------------------------------
    let sources = await getJson('/sources');
    let datasets = await getJson('/datasets');
    let cohorts = await getJson('/cohorts');
    const sourceId = (n) => (sources.find((s) => s.source_name === n) || {}).id;
    const datasetId = (k) => {
      const [name, version] = k.split('||');
      return (datasets.find((d) => d.dataset_name === name && d.version === version) || {}).id;
    };
    const cohortId = (c) => (cohorts.find((x) => x.cohort_code === c) || {}).id;

    // ---- pre-flight -----------------------------------------------------------------------------------
    const problems = [];
    const needsNewSource = payload.sources.filter((s) => !sourceId(s.body.source_name));
    const needsNewDataset = payload.datasets.filter((d) => !datasetId(d.body.dataset_name + '||' + d.body.version));
    const datasetKeysInValues = [...new Set(payload.values.map((v) => v.datasetKey))];
    for (const k of datasetKeysInValues) {
      const willExist = datasetId(k) || payload.datasets.some((d) => d.body.dataset_name + '||' + d.body.version === k);
      if (!willExist) problems.push('dataset not registered and not in payload: ' + k);
    }
    for (const k of datasetKeysInValues) {
      const id = datasetId(k);
      if (!id) continue;
      const existing = await getJson('/values?dataset_id=' + encodeURIComponent(id));
      if (existing.length > 0) problems.push('dataset "' + k.replace('||', ' v') + '" already has ' + existing.length + '+ value rows; refusing to load it again');
    }
    const cohortsToCreate = payload.cohorts.filter((c) => !cohortId(c.body.cohort_code));
    const newCohortCodes = new Set(cohortsToCreate.map((c) => c.body.cohort_code));
    for (const v of payload.values) {
      if (v.cohortCode && !cohortId(v.cohortCode) && !newCohortCodes.has(v.cohortCode)) problems.push('value row references unknown cohort ' + v.cohortCode);
    }
    for (const m of [...new Set(payload.targetRanges.map((t) => t.metricCode))]) {
      const existing = await getJson('/target-ranges?metric_code=' + encodeURIComponent(m));
      for (const t of payload.targetRanges.filter((x) => x.metricCode === m)) {
        const dup = existing.find((e) => e.band_label === t.body.band_label && e.country_code === (t.body.country_code || null) && e.household_type === (t.body.household_type || null) && e.model_version === t.body.model_version);
        if (dup) problems.push('target range already exists: ' + m + ' ' + t.body.band_label + ' ' + (t.body.country_code || '-') + ' ' + (t.body.household_type || '-'));
      }
    }

    note('plan: sources new=' + needsNewSource.length + ' (of ' + payload.sources.length + '), datasets new=' + needsNewDataset.length + ', cohorts new=' + cohortsToCreate.length + ', values=' + payload.values.length + ', target ranges=' + payload.targetRanges.length);
    if (problems.length) {
      problems.slice(0, 50).forEach((p) => note('BLOCKED: ' + p));
      note('Nothing was written. Fix the blocking items above first.');
      return { ok: false, dryRun, problems, created };
    }
    if (dryRun) {
      note('DRY RUN complete: pre-flight clean, nothing written. Re-run with { dryRun: false } to write.');
      return { ok: true, dryRun: true, problems: [], created };
    }

    // ---- writes (stop at first failure) ---------------------------------------------------------------
    try {
      for (const s of needsNewSource) {
        const row = await postJson('/sources', s.body);
        created.sources.push(row.id);
      }
      sources = await getJson('/sources');
      for (const d of needsNewDataset) {
        const sid = sourceId(d.sourceName);
        if (!sid) throw new Error('source not found for dataset ' + d.body.dataset_name + ': ' + d.sourceName);
        const row = await postJson('/datasets', Object.assign({}, d.body, { benchmark_source_id: sid }));
        created.datasets.push(row.id);
      }
      datasets = await getJson('/datasets');
      for (const c of cohortsToCreate) {
        const did = datasetId(c.datasetKey);
        if (!did) throw new Error('dataset not found for cohort ' + c.body.cohort_code);
        const row = await postJson('/cohorts', Object.assign({}, c.body, { dataset_id: did }));
        created.cohorts.push(row.id);
      }
      cohorts = await getJson('/cohorts');
      for (let i = 0; i < payload.values.length; i += chunkSize) {
        const rows = payload.values.slice(i, i + chunkSize).map((v) => {
          const did = datasetId(v.datasetKey);
          if (!did) throw new Error('dataset not found: ' + v.datasetKey);
          const body = Object.assign({}, v.body, { dataset_id: did, metric_definition_id: payload.metricIds[v.metricCode] });
          if (v.cohortCode) {
            const cid = cohortId(v.cohortCode);
            if (!cid) throw new Error('cohort not found: ' + v.cohortCode);
            body.cohort_id = cid;
          }
          return body;
        });
        const res = await postJson('/values', { rows: rows });
        res.rows.forEach((r) => created.values.push(r.id));
        note('values ' + Math.min(i + chunkSize, payload.values.length) + '/' + payload.values.length);
      }
      for (const t of payload.targetRanges) {
        const body = Object.assign({}, t.body, { metric_definition_id: payload.metricIds[t.metricCode] });
        if (t.sourceName) {
          const sid = sourceId(t.sourceName);
          if (!sid) throw new Error('source not found for target range: ' + t.sourceName);
          body.benchmark_source_id = sid;
        }
        const row = await postJson('/target-ranges', body);
        created.targetRanges.push(row.id);
      }
      note('DONE: created sources=' + created.sources.length + ' datasets=' + created.datasets.length + ' cohorts=' + created.cohorts.length + ' values=' + created.values.length + ' targetRanges=' + created.targetRanges.length);
    } catch (e) {
      note('STOPPED at first failure: ' + (e && e.message ? e.message : e));
      note('Rows already created are listed in the log; use the rollback SQL to remove them.');
      emitLog(false);
      return { ok: false, dryRun: false, error: String(e && e.message ? e.message : e), created };
    }
    emitLog(true);
    return { ok: true, dryRun: false, created };

    function emitLog(success) {
      const q = (ids) => ids.map((i) => "'" + i + "'").join(', ');
      const rollback = [
        '-- Rollback for this import run. Review, then run in the SQL editor of the SAME environment.',
        '-- Children first. Nothing here touches rows this run did not create.',
        created.targetRanges.length ? 'delete from benchmark_target_ranges where id in (' + q(created.targetRanges) + ');' : '-- no target ranges created',
        created.values.length ? 'delete from benchmark_values where id in (' + q(created.values) + ');' : '-- no values created',
        created.cohorts.length ? 'delete from benchmark_cohorts where id in (' + q(created.cohorts) + ');' : '-- no cohorts created',
        created.datasets.length ? 'delete from benchmark_datasets where id in (' + q(created.datasets) + ');' : '-- no datasets created',
        created.sources.length ? 'delete from benchmark_sources where id in (' + q(created.sources) + ');' : '-- no sources created',
      ].join('\n');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      download('planning_benchmarks_first_load_log_' + stamp + '.json', JSON.stringify({ success: success, created: created, events: events }, null, 2));
      download('planning_benchmarks_first_load_rollback_' + stamp + '.sql', rollback);
    }
  }

  globalThis.pbPickPayload = pbPickPayload;
  globalThis.pbRunImport = pbRunImport;
  console.log('pbPickPayload() and pbRunImport(payload, { dryRun }) are ready.');
})();
