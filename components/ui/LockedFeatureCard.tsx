import { Lock } from 'lucide-react';

export function LockedFeatureCard({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex items-start gap-3 rounded-card border border-dashed bg-gray-50 p-6">
      <Lock className="mt-1 h-5 w-5 text-gray-400" />
      <div>
        <p className="font-medium text-gray-700">{title}</p>
        <p className="mt-1 text-sm text-gray-500">{description}</p>
      </div>
    </div>
  );
}
