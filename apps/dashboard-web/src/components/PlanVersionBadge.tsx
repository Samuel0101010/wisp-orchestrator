import { Badge } from '@/components/ui/badge';
import { usePlanVersionChain } from '@/api/queries';

interface Props {
  planId: string | undefined;
}

/**
 * Renders the plan-version badge:
 * - chain length 1 (root plan, no replan history) → nothing
 * - chain length 2+ → "v<N> (replanned)" badge with hover-listing of ancestor plan ids.
 *
 * Versions are 1-indexed from the root: v1 is the original plan, v2 is the
 * first replan, etc.
 */
export function PlanVersionBadge({ planId }: Props) {
  const { data: chain = [] } = usePlanVersionChain(planId);
  if (chain.length <= 1) return null;
  // Chain is newest-first; the requested plan is index 0. Version is total length.
  const version = chain.length;
  const ancestors = chain.slice(1); // older versions

  const summary = ancestors
    .map((a, i) => `v${chain.length - 1 - i} ${a.id.slice(0, 8)} (${a.status})`)
    .join(' → ');

  return (
    <Badge
      variant="outline"
      className="text-[10px] uppercase"
      title={`Replan chain (oldest → newest): ${summary} → v${version} (this plan)`}
      data-testid="plan-version-badge"
    >
      v{version} (replanned)
    </Badge>
  );
}
