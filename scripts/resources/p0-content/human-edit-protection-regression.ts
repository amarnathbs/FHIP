// R1.7C closure §27 — prove the loader's human-edit protection actually
// works: create a disposable auth user, simulate a genuine human edit
// (updated_by set, exactly like the real editor save path would do) on ONE
// real P0 post, run the loader, confirm SKIPPED_HUMAN_EDIT (not overwritten),
// then restore the post to its certified state and delete the fixture user.
import { createClient } from '@supabase/supabase-js';
import { assertDevProject } from '../lib/env';

const TEST_CONTENT_ID = 'GLO-001'; // a small, easy-to-restore record

async function main() {
  const creds = assertDevProject();
  const supa = createClient(creds.url, creds.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  console.log(`[Human-Edit Protection Regression] project=${creds.projectRef} target=${TEST_CONTENT_ID}`);

  // 1. Snapshot the real certified state so we can restore it exactly.
  const { data: before, error: beforeErr } = await supa
    .from('resource_posts')
    .select('id,content_id,content_blocks,excerpt,seo_title,seo_description,updated_by,updated_at')
    .eq('content_id', TEST_CONTENT_ID)
    .single();
  if (beforeErr || !before) { console.error('FATAL: could not read target post', beforeErr); process.exit(1); }
  console.log(`Captured certified state: updated_by=${before.updated_by}, content_blocks length=${(before.content_blocks as unknown[]).length}`);

  // 2. Create a disposable auth user to act as the "human editor".
  const email = `r17c-human-edit-test-${Date.now()}@example.invalid`;
  const { data: created, error: createErr } = await supa.auth.admin.createUser({ email, email_confirm: true });
  if (createErr || !created.user) { console.error('FATAL: could not create disposable user', createErr); process.exit(1); }
  const fixtureUserId = created.user.id;
  console.log(`Created disposable fixture user ${fixtureUserId}`);

  try {
    // 3. Simulate a genuine human edit: set updated_by (only the real editor
    // save path does this; the loader never does) and slightly change the
    // excerpt so we can prove it wasn't silently overwritten.
    const humanEditedExcerpt = `[HUMAN-EDIT-TEST-FIXTURE ${Date.now()}] This excerpt was edited by a human, not the loader.`;
    const { error: editErr } = await supa
      .from('resource_posts')
      .update({ updated_by: fixtureUserId, excerpt: humanEditedExcerpt })
      .eq('id', before.id);
    if (editErr) { console.error('FATAL: could not simulate human edit', editErr); process.exit(1); }
    console.log('Simulated human edit applied (updated_by set, excerpt changed).');

    // 4. Run the real loader (apply mode) and check the outcome for this ID.
    const { execSync } = await import('node:child_process');
    const out = execSync('npx tsx --env-file=.env.local scripts/resources/p0-content/load-p0-content.ts -- --apply --confirm-project=vqycarelcoijzwlpkpcz', { cwd: process.cwd() }).toString();
    console.log(out);

    // 5. Verify: excerpt must still be the human-edited one, not reverted.
    const { data: after } = await supa.from('resource_posts').select('excerpt,updated_by').eq('id', before.id).single();
    const skipped = after?.excerpt === humanEditedExcerpt;
    console.log(`Post-loader excerpt: ${after?.excerpt}`);
    console.log(skipped ? 'PASS: human edit was NOT overwritten (SKIPPED_HUMAN_EDIT worked).' : 'FAIL: the loader overwrote a human edit!');

    if (!skipped) {
      console.error('CRITICAL: human-edit protection regression FAILED. Restoring immediately.');
    }

    process.exitCode = skipped ? 0 : 1;
  } finally {
    // 6. Restore exact certified state and clean up, regardless of outcome.
    const { error: restoreErr } = await supa
      .from('resource_posts')
      .update({
        content_blocks: before.content_blocks,
        excerpt: before.excerpt,
        seo_title: before.seo_title,
        seo_description: before.seo_description,
        updated_by: before.updated_by,
      })
      .eq('id', before.id);
    if (restoreErr) console.error('WARNING: restore failed', restoreErr);
    else console.log(`Restored ${TEST_CONTENT_ID} to its exact pre-test certified state (updated_by back to ${before.updated_by}).`);

    const { data: verify } = await supa.from('resource_posts').select('excerpt,updated_by').eq('id', before.id).single();
    console.log(`Post-restore verification: excerpt matches=${verify?.excerpt === before.excerpt}, updated_by matches=${verify?.updated_by === before.updated_by}`);

    const { error: delErr } = await supa.auth.admin.deleteUser(fixtureUserId);
    if (delErr) console.error('WARNING: fixture user cleanup failed', delErr);
    else console.log(`Deleted disposable fixture user ${fixtureUserId}.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
