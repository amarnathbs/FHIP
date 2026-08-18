import { PublicLoadingState } from '@/components/resources/public/PublicStates';

export default function ResourcesLoading() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <PublicLoadingState />
    </div>
  );
}
