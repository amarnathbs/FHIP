"""Mutation proof for the owner-change negative controls.
Apply ONE deliberate rule-breaking edit, run the four owner suites, record which named assertions fail, restore the file.
A control that stays green under its mutation is not a control. Results merge into mutation_results.json (keyed by Mnn)."""
import subprocess, sys, json, os

WT = os.environ.get('OWNER_WT', os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')))  # repo / worktree root
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'mutation_results.json')  # written next to this script; run from any cwd
OWNER_TESTS = ['tests/unit/iiOwnerModel.test.ts', 'tests/unit/iiOwnerChangeRoutes.test.ts', 'tests/unit/iiOwnerSeparationReaders.test.ts', 'tests/unit/iiOwnerChangeDialogUi.test.ts']

ACC = 'lib/services/investment-intelligence/accountOwnership.ts'
MODEL = 'lib/services/investment-intelligence/ownerModel.ts'
PATCH_ROUTE = 'app/api/investment-intelligence/accounts/[id]/owner/route.ts'
AMEND_ROUTE = 'app/api/investment-intelligence/resolutions/[caseId]/amend/route.ts'

# (name, file, [(old, new), ...])
MS = [
 ('M01 cross-tenant member accepted', MODEL, [("    if (!m) return fail(404, 'OWNER_MEMBER_NOT_FOUND', 'That household member was not found.');", "    if (!m) return { ok: true, role: 'other' };")]),
 ('M02 inactive member accepted', MODEL, [("    if (m.is_active === false) return fail(422, 'OWNER_MEMBER_INACTIVE',", "    if (false) return fail(422, 'OWNER_MEMBER_INACTIVE',")]),
 ('M03 HUF country gate removed', MODEL, [("if (requiredCountry && ctx.homeCountry !== requiredCountry) {", "if (false && requiredCountry && ctx.homeCountry !== requiredCountry) {")]),
 ('M04 foreign / absent entity accepted (company-only-if-owned, cross-tenant entity)', MODEL, [("  if (!e) return fail(404, 'OWNER_ENTITY_NOT_FOUND', 'That trust, HUF or company was not found.');", "  if (!e) return { ok: true, role: 'company' };")]),
 ('M05 joint allocation maths skipped (total / duplicate / zero)', MODEL, [("  const validated = validateAllocation(entries);\n  if (!validated.ok) return fail(", "  const validated = { ok: true as const, entries };\n  if (!validated.ok) return fail(")]),
 ('M06 PATCH does not require confirm', PATCH_ROUTE, [("  if (parsed.data.confirm !== true) {", "  if (false) {")]),
 ('M07 amend does not require confirm', AMEND_ROUTE, [("  if (ownerParsed?.success && ownerParsed.data.confirm !== true) {", "  if (false) {")]),
 ('M08 replay not idempotent (always writes a new allocation group)', ACC, [("  const unchanged = sameOwnership(before, after);", "  const unchanged = false;")]),
 ('M09 apply rewrites already-resolved cases (immutability broken)', ACC, [
   ("    .in('discrepancy_type', [...types])\n    .eq('status', 'open');", "    .in('discrepancy_type', [...types])\n    .in('status', ['open', 'resolved']);"),
   (".eq('id', c.id)\n      .eq('status', 'open'); // race guard: only this row, only if still open", ".eq('id', c.id);")]),
 ('M10 PATCH lets a sole owner resolve a joint-holding case', PATCH_ROUTE, [("theCase.discrepancy_type === 'joint_holding_allocation_required' && validated.owner.kind !== 'joint'", "false")]),
 ('M11 amend lets a joint case be amended to a sole owner', AMEND_ROUTE, [("if (priorCase.discrepancy_type === 'joint_holding_allocation_required' && validated.owner.kind !== 'joint') {", "if (false) {")]),
 ('M12 accepted change writes NO audit row', ACC, [("  if (!unchanged || resolvedCaseIds.length > 0) {", "  if (false) {")]),
 ('M13 audit written even for a no-op replay', ACC, [("  if (!unchanged || resolvedCaseIds.length > 0) {", "  if (true) {")]),
 ('M14 audit metadata leaks a name', MODEL, [
   ("basisPoints: s.basisPoints })) };\n}\n\n// ---------------------------------------------------------------------------\n// Validation", "basisPoints: s.basisPoints, name: 'Asha Rao' })) };\n}\n\n// ---------------------------------------------------------------------------\n// Validation")]),
 ('M15 account tenant scope removed from loadAccountOwnership', ACC, [("const { data: account } = await client.from('ii_accounts').select('id, owner_member_id').eq('id', accountId).eq('user_id', userId).maybeSingle();", "const { data: account } = await client.from('ii_accounts').select('id, owner_member_id').eq('id', accountId).maybeSingle();")]),
 ('M16 published-account entity guard removed', ACC, [("if (!unchanged && ownershipBlocksPersonalPublication(after) && hasPublication) {", "if (false) {")]),
 ('M17 entity-owned holdings offered to personal Net Worth (read model)', 'lib/read-models/investments.ts', [("    if (input.entityOwnedAccountIds?.has(s.account_id)) {", "    if (false) {")]),
 ('M18 entity-owned account publishable (eligibility)', 'lib/services/investment-intelligence/publicationLogic.ts', [("if (input.ownership && input.ownership.kind !== 'unassigned' && input.ownership.hasEntity) {", "if (false) {")]),
 ('M19 AU ownerRecorded reads only the pointer', 'lib/investment-import-bridge/auAccountResolution.ts', [("ownerRecorded: Boolean(a.owner_member_id) || decided.has(a.id),", "ownerRecorded: Boolean(a.owner_member_id),")]),
 ('M20 HUF offered to a non-India user in the picker', MODEL, [("      return !required || ctx.homeCountry === required;", "      return true;")]),
 ('M21 UI: >2 decimals accepted as a percentage', 'components/investment-intelligence/ownerChange.ts', [("if (!/^\\d+(\\.\\d{1,2})?$/.test(t) && !/^\\.\\d{1,2}$/.test(t)) return null;", "if (!/^\\d+(\\.\\d+)?$/.test(t)) return null;")]),
 ('M22 UI: joint total not checked', 'components/investment-intelligence/ownerChange.ts', [("if (total !== PC5_TOTAL_BASIS_POINTS && rows.every(", "if (false && total !== PC5_TOTAL_BASIS_POINTS && rows.every(")]),
 ('M23 UI: confirm enabled for a published -> entity move', 'components/investment-intelligence/OwnerChangeDialog.tsx', [("disabled={submitting || description.blockedUntilUnpublished}", "disabled={submitting}")]),
 ('M24 effective ownership ignores the allocation (pointer only)', MODEL, [("  if (accountGrain.length > 0) {", "  if (false && accountGrain.length > 0) {")]),
 ('M25 member choice leaves the pointer unset', ACC, [("  if (current.pointerMemberId !== owner.pointerMemberId) {", "  if (false) {")]),
 ('M26 upload pipeline re-opens owner cases on decided accounts', 'lib/services/investment-intelligence/documentProcessing.ts', [
   ("      if (decidedOwnershipAccountIds.has(accountId)) continue; // owner already decided as entity / joint split\n      const acctRecord = accountRecordByFolioForJointCheck", "      const acctRecord = accountRecordByFolioForJointCheck")]),
 ('M27 generic Resolve closes a joint-holding case with no owner decision', 'app/api/investment-intelligence/reconciliation-cases/[id]/resolve/route.ts', [("  if (existing.discrepancy_type === 'joint_holding_allocation_required') {", "  if (false) {")]),
]


def run_tests():
    r = subprocess.run('npx vitest run ' + ' '.join(OWNER_TESTS) + ' --reporter=json', cwd=WT, shell=True, capture_output=True, text=True, timeout=900, encoding='utf-8')
    txt = r.stdout
    i = txt.find('{')
    try:
        data = json.loads(txt[i:txt.rfind('}') + 1])
    except Exception as e:
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
    failed, err = run_tests()
    print('baseline failing:', failed, err)
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
