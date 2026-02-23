import { formatBytes, sizeColorClass, cn, type SizeThresholds } from '@/lib/utils';

interface SizeLabelProps {
  bytes: number;
  sizeThresholds?: SizeThresholds;
  className?: string;
}

export function SizeLabel({ bytes, sizeThresholds, className }: SizeLabelProps) {
  if (bytes < 0) return null;

  return (
    <span
      className={cn(
        'text-[11px] inline-flex items-center gap-0.5',
        sizeColorClass(bytes, sizeThresholds),
        className,
      )}
    >
      {formatBytes(bytes)}
    </span>
  );
}
