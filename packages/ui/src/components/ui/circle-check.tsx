import * as React from 'react';
import { cn } from '@/lib/utils';

interface CircleCheckProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  onCheckedChange?: (checked: boolean) => void;
}

const CircleCheck = React.forwardRef<HTMLInputElement, CircleCheckProps>(
  ({ className, checked, onCheckedChange, onChange, ...props }, ref) => {
    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      onChange?.(e);
      onCheckedChange?.(e.target.checked);
    };

    return (
      <label className={cn('relative inline-flex items-center cursor-pointer shrink-0', className)}>
        <input
          type="checkbox"
          ref={ref}
          checked={checked}
          onChange={handleChange}
          className="sr-only"
          {...props}
        />
        <span
          className={cn(
            'h-3.5 w-3.5 rounded-full border-[1.5px] transition-colors flex items-center justify-center',
            checked ? 'border-primary bg-primary' : 'border-muted-foreground/40 bg-transparent',
          )}
        >
          {checked && (
            <svg
              className="h-2 w-2 text-primary-foreground"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M2 6l3 3 5-5" />
            </svg>
          )}
        </span>
      </label>
    );
  },
);
CircleCheck.displayName = 'CircleCheck';

export { CircleCheck };
