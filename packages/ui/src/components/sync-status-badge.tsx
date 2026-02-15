import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface SyncStatusBadgeProps {
  status: string;
  size?: 'default' | 'sm';
}

export function SyncStatusBadge({ status, size = 'default' }: SyncStatusBadgeProps) {
  const sizeClass = size === 'sm' ? 'text-[10px] px-1.5 py-0' : '';

  switch (status) {
    case 'synced':
      return (
        <Badge variant="success" className={cn(sizeClass)}>
          Synced
        </Badge>
      );
    case 'conflict':
      return (
        <Badge variant="warning" className={cn(sizeClass)}>
          Conflict
        </Badge>
      );
    case 'pending_to_target':
    case 'pending_to_store':
      return (
        <Badge variant="warning" className={cn(sizeClass)}>
          Pending
        </Badge>
      );
    case 'missing_in_store':
      return (
        <Badge variant="destructive" className={cn(sizeClass)}>
          Store Removed
        </Badge>
      );
    case 'missing_in_target':
      return (
        <Badge variant="destructive" className={cn(sizeClass)}>
          Target Removed
        </Badge>
      );
    case 'active':
      return (
        <Badge variant="success" className={cn(sizeClass)}>
          Active
        </Badge>
      );
    case 'paused':
      return (
        <Badge variant="secondary" className={cn(sizeClass)}>
          Paused
        </Badge>
      );
    case 'error':
      return (
        <Badge variant="destructive" className={cn(sizeClass)}>
          Error
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className={cn(sizeClass)}>
          {status}
        </Badge>
      );
  }
}
