import { formatBytes, sizeColorClass, cn } from '@/lib/utils';

interface SizeLabelProps {
  bytes: number;
  className?: string;
}

export function SizeLabel({ bytes, className }: SizeLabelProps) {
  if (bytes < 0) return null;

  return (
    <span
      className={cn(
        'text-[11px] inline-flex items-center gap-0.5',
        sizeColorClass(bytes),
        className,
      )}
    >
      {formatBytes(bytes)}
    </span>
  );
}
