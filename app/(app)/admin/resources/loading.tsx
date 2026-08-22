import { ResourceLoadingSkeleton } from '@/components/resources/admin/ResourceStates';

export default function ResourcesAdminLoading() {
  return (
    <div className="space-y-4">
      <div className="h-8 w-48 animate-pulse rounded bg-gray-100" />
      <ResourceLoadingSkeleton rows={5} />
    </div>
  );
}
