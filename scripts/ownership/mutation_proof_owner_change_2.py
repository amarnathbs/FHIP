"""Mutation proof, part 2 (2026-10-01 PO decisions: not-joint override, divide-by-basis-points attribution,
owner classes, report scope). Same mechanism as mutation_proof_owner_change.py: ONE deliberate rule-breaking edit,
run every owner suite, record the failing assertions, restore the file from its in-memory original.

Run:  python scripts/ownership/mutation_proof_owner_change_2.py            (all)
      python scripts/ownership/mutation_proof_owner_change_2.py M30 M31    (some)
Results: docs/ownership/owner_change_mutation_results_2.json.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WT = os.environ.get('OWNER_WT', os.path.abspath(os.path.join(HERE, '..', '..')))
OUT = os.path.join(HERE, '..', '..', 'docs', 'ownership', 'owner_change_mutation_results_2.json')
NL = '\n'
TESTS = [
    'tests/unit/iiOwnerModel.test.ts',
    'tests/unit/iiOwnerChangeRoutes.test.ts',
    'tests/unit/iiOwnerSeparationReaders.test.ts',
    'tests/unit/iiOwnerChangeDialogUi.test.ts',
    'tests/unit/iiJointValueAttribution.test.ts',
    'tests/unit/iiOwnerClassBreakup.test.ts',
    'tests/unit/iiOwnerClassUi.test.ts',
    'tests/unit/iiOwnerClassRoutes.test.ts',
    'tests/unit/iiOwnerClassReport.test.ts',
]
MODEL = 'lib/services/investment-intelligence/ownerModel.ts'
ATTR = 'lib/services/investment-intelligence/ownerAttribution.ts'
OC = 'lib/services/investment-intelligence/ownerClass.ts'

# (name, file, [(old, new), ...])
MS = [
    ('M28 not-joint override needs no second confirmation', MODEL, [("ownerKind === 'joint' || confirmNotJoint === true) return null;", "ownerKind === 'joint' || true) return null;")]),
    ('M29 a sole owner resolves a joint case without the flag (apply)', MODEL, [("return kind === 'joint' || notJointConfirmed ? OWNER_CASE_TYPES", "return kind === 'joint' || true ? OWNER_CASE_TYPES")]),
    ('M30 attribution accepts a split that is not 10000', ATTR, [("  if (total !== OWNERSHIP_TOTAL_BASIS_POINTS) return null;" + NL, "")]),
    ('M31 attribution drops the rounding remainder (shares do not add back)', ATTR, [("  let remainder = totalUnits - floors.reduce((a, b) => a + b, 0);", "  let remainder = 0;")]),
    ('M32 read model divides an incomplete (not 10000) joint group', 'lib/read-models/investments.ts', [("if (group.reduce((s, r) => s + r.allocation_basis_points, 0) !== 10000) continue;", "if (false) continue;")]),
    ('M33 owner-class scope forgets ii_transactions', OC, [("  ii_transactions: 'account_id'," + NL, "")]),
    ('M34 scoped client allows writes (a per-class run could persist)', OC, [("if (prop === 'insert' || prop === 'update' || prop === 'upsert' || prop === 'delete') {", "if (false) {")]),
    ('M35 entity-shared account classified as plain joint (personal-looking)', OC, [("  return o.hasEntity ? { key: 'entity_shared'", "  return false ? { key: 'entity_shared'")]),
    ('M36 macro line double-counts', OC, [("    addCurrency(consolidatedCurrencies, p.currencyCode, p.value);" + NL, "    addCurrency(consolidatedCurrencies, p.currencyCode, p.value);" + NL + "    addCurrency(consolidatedCurrencies, p.currencyCode, p.value);" + NL)]),
    ('M37 report chapters run on the unscoped client', 'lib/services/reportSnapshotResolver.ts', [("loadSipForReport(userId, iiScope.client)", "loadSipForReport(userId, supabase)")]),
    ('M38 a per-class SIP run persists over the consolidated rows', 'app/api/investment-intelligence/sip/route.ts', [("scope.active ? { persisted: 0, error: null as string | null } : await persistR5Results(", "false ? { persisted: 0, error: null as string | null } : await persistR5Results(")]),
    ('M39 incomplete allocation group trusted as an owner', MODEL, [("    if (shares.reduce((s, x) => s + x.basisPoints, 0) !== PC5_TOTAL_BASIS_POINTS) return { kind: 'unassigned' };" + NL, "")]),
    ('M40 a foreign / unknown owner class is accepted', 'lib/services/investment-intelligence/ownerClassScope.ts', [("  if (!info) return { ok: false", "  if (false) return { ok: false")]),
    ('M41 report does not exclude entity data', 'lib/services/investment-intelligence/ownerClassReportScope.ts', [("  if (!hasEntity) return { client: supabase, breakup };", "  if (true) return { client: supabase, breakup };")]),
]


def run_tests():
    r = subprocess.run('npx vitest run ' + ' '.join(TESTS) + ' --reporter=json', cwd=WT, shell=True, capture_output=True, text=True, timeout=1200, encoding='utf-8')
    txt = r.stdout
    i = txt.find('{')
    try:
        data = json.loads(txt[i:txt.rfind('}') + 1])
    except Exception as e:  # noqa: BLE001
        return None, f'unparseable: {e}: {(txt + r.stderr)[-250:]}'
    failed = []
    for f in data.get('testResults', []):
        for t in f.get('assertionResults', []):
            if t.get('status') == 'failed':
                failed.append(t.get('fullName'))
        if f.get('status') == 'failed' and not f.get('assertionResults'):
            failed.append('SUITE FAILED TO RUN: ' + f.get('name', '')[-60:] + ' ' + (f.get('message') or '')[:120])
    return failed, None


results = json.load(open(OUT)) if os.path.exists(OUT) else []


def put(r):
    key = r['mutation'][:3]
    results[:] = [x for x in results if x['mutation'][:3] != key] + [r]
    results.sort(key=lambda x: x['mutation'][:3])
    json.dump(results, open(OUT, 'w'), indent=1)


only = sys.argv[1:]
if only == ['BASELINE']:
    print('baseline failing:', run_tests())
    sys.exit(0)
for name, path, pairs in MS:
    if only and not any(name.startswith(o) for o in only):
        continue
    p = os.path.join(WT, path)
    src = open(p, 'r', newline='', encoding='utf-8').read()
    bad = [o for o, _ in pairs if src.count(o) != 1]
    if bad:
        put({'mutation': name, 'file': path, 'error': 'pattern count error for ' + repr(bad[0][:70])})
        print(name, 'PATTERN ERROR', repr(bad[0][:70]))
        continue
    mutated = src
    for o, n in pairs:
        mutated = mutated.replace(o, n)
    try:
        open(p, 'w', newline='', encoding='utf-8').write(mutated)
        failed, err = run_tests()
    finally:
        open(p, 'w', newline='', encoding='utf-8').write(src)
    put({'mutation': name, 'file': path, 'failed': failed, 'error': err})
    print(f"{name}: {'ERROR ' + err if err else str(len(failed)) + ' failing'}", flush=True)
