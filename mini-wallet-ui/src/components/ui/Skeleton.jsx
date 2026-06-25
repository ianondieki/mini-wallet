import { cn } from '../../lib/utils.js';

/** Shimmer placeholder block used during loading states. */
export default function Skeleton({ className }) {
  return <div className={cn('skeleton rounded-lg', className)} aria-hidden="true" />;
}
