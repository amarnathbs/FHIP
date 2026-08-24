import { redirect } from 'next/navigation';
import { requireResourceAdminAccess } from '@/lib/resources/admin/access';
import { canManageResources } from '@/lib/resources/permissions';
import { ResourceUsersClient } from '@/components/resources/admin/ResourceUsersClient';

// /admin/resources/users — Users & Roles admin (spec §5/§6). Follows the
// existing flat /admin/resources/<feature> convention (ctas, faqs, glossary,
// related, context) rather than the spec's suggested /admin/resources/
// settings/users nesting, for consistency with every sibling Resources admin
// screen already shipped — see the completion report section G for the
// explicit deviation note.
export default async function ResourceUsersPage() {
  const current = await requireResourceAdminAccess();
  // spec §5: "Only authorised Resource Admin/Super Admin users should be
  // able to access role-management functions" — a stricter gate than the
  // shell's own isResourceStaff() entry check (which lets any Resources
  // role in the door for read-only screens elsewhere).
  if (!canManageResources(current)) redirect('/admin/resources');
  return <ResourceUsersClient currentUserId={current.userId ?? ''} />;
}
