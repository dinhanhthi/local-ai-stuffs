import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CircleCheck } from '@/components/ui/circle-check';
import { SourceBadge } from '@/components/pattern-list';
import { RotateCcw } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface SettingRowProps {
  label: string;
  settingKey: string;
  type: string;
  value: string;
  source?: 'global' | 'local';
  onChange: (value: string) => void;
  onReset?: () => void;
}

export function SettingRow({
  label,
  settingKey,
  type,
  value,
  source,
  onChange,
  onReset,
}: SettingRowProps) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-center gap-2">
        <Label htmlFor={settingKey} className="text-xs">
          {label}
        </Label>
        {source && <SourceBadge source={source} />}
        {source === 'local' && onReset && (
          <TooltipProvider delayDuration={300}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={onReset}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <RotateCcw className="h-3 w-3" />
                </button>
              </TooltipTrigger>
              <TooltipContent>Reset to global value</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
      </div>
      <Input
        id={settingKey}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 text-sm"
      />
    </div>
  );
}

interface CheckboxSettingRowProps {
  label: string;
  settingKey: string;
  checked: boolean;
  source?: 'global' | 'local';
  onCheckedChange: (checked: boolean) => void;
  onReset?: () => void;
}

export function CheckboxSettingRow({
  label,
  settingKey,
  checked,
  source,
  onCheckedChange,
  onReset,
}: CheckboxSettingRowProps) {
  return (
    <div className="flex items-center gap-2">
      <CircleCheck id={settingKey} checked={checked} onCheckedChange={onCheckedChange} />
      <Label htmlFor={settingKey} className="text-sm font-normal">
        {label}
      </Label>
      {source && <SourceBadge source={source} />}
      {source === 'local' && onReset && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onReset}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <RotateCcw className="h-3 w-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent>Reset to global value</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}
