import { useState, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { api, type AvailableService } from '@/lib/api';
import { FolderBrowser } from './folder-browser';
import { Loader2, FolderOpen, X, Plus, ImageIcon } from 'lucide-react';

interface AddCustomServiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
  existingServices: AvailableService[];
}

function slugify(name: string): string {
  return (
    'custom-' +
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
  );
}

export function AddCustomServiceDialog({
  open,
  onOpenChange,
  onAdded,
  existingServices,
}: AddCustomServiceDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [patterns, setPatterns] = useState<string[]>([]);
  const [patternInput, setPatternInput] = useState('');
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const serviceType = slugify(name);
  const isDuplicate =
    name.trim().length > 0 && existingServices.some((s) => s.serviceType === serviceType);

  const canSubmit =
    name.trim().length > 0 &&
    localPath.trim().length > 0 &&
    patterns.length > 0 &&
    !isDuplicate &&
    !submitting;

  const resetForm = () => {
    setName('');
    setDescription('');
    setLocalPath('');
    setBrowsing(false);
    setPatterns([]);
    setPatternInput('');
    setIconFile(null);
    setIconPreview(null);
    setError(null);
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) resetForm();
    onOpenChange(open);
  };

  const handleIconChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIconFile(file);
    const reader = new FileReader();
    reader.onloadend = () => setIconPreview(reader.result as string);
    reader.readAsDataURL(file);
  };

  const addPattern = () => {
    const p = patternInput.trim();
    if (p && !patterns.includes(p)) {
      setPatterns([...patterns, p]);
    }
    setPatternInput('');
  };

  const removePattern = (pattern: string) => {
    setPatterns(patterns.filter((p) => p !== pattern));
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('name', name.trim());
      formData.append('description', description.trim());
      formData.append('localPath', localPath.trim());
      formData.append('patterns', JSON.stringify(patterns));
      if (iconFile) {
        formData.append('icon', iconFile);
      }
      await api.services.createCustom(formData);
      onAdded();
      handleOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create service');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Custom Service</DialogTitle>
          <DialogDescription>
            Configure a custom AI service to sync its configuration files.
          </DialogDescription>
        </DialogHeader>

        {browsing ? (
          <FolderBrowser
            onSelect={(path) => {
              setLocalPath(path);
              setBrowsing(false);
            }}
            onCancel={() => setBrowsing(false)}
            showDotFiles
          />
        ) : (
          <div className="space-y-4 py-2">
            {/* Service Name */}
            <div className="space-y-1.5">
              <Label htmlFor="service-name" className="text-xs">
                Service Name
              </Label>
              <Input
                id="service-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Windsurf"
              />
              {isDuplicate && (
                <p className="text-xs text-destructive">
                  A service with type &quot;{serviceType}&quot; already exists.
                </p>
              )}
            </div>

            {/* Description */}
            <div className="space-y-1.5">
              <Label htmlFor="service-desc" className="text-xs">
                Description
                <span className="text-muted-foreground ml-1">(optional)</span>
              </Label>
              <Input
                id="service-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Short description of the service"
              />
            </div>

            {/* Icon Upload */}
            <div className="space-y-1.5">
              <Label className="text-xs">
                Icon
                <span className="text-muted-foreground ml-1">(optional)</span>
              </Label>
              <div className="flex items-center gap-3">
                {iconPreview ? (
                  <div className="relative h-10 w-10 rounded-md border shrink-0 flex items-center justify-center">
                    <img src={iconPreview} alt="Icon preview" className="h-6 w-6 object-cover" />
                    <button
                      type="button"
                      onClick={() => {
                        setIconFile(null);
                        setIconPreview(null);
                        if (fileInputRef.current) fileInputRef.current.value = '';
                      }}
                      className="absolute -top-1 -right-1 h-4 w-4 bg-background rounded-full border border-border flex items-center justify-center"
                    >
                      <X className="h-2.5 w-2.5" />
                    </button>
                  </div>
                ) : (
                  <div className="h-10 w-10 rounded-md border border-dashed flex items-center justify-center text-muted-foreground shrink-0">
                    <ImageIcon className="h-4 w-4" />
                  </div>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                >
                  Choose File
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleIconChange}
                />
              </div>
            </div>

            {/* Config Path */}
            <div className="space-y-1.5">
              <Label htmlFor="service-path" className="text-xs">
                Config Path
              </Label>
              <div className="flex gap-2 items-center">
                <Input
                  id="service-path"
                  value={localPath}
                  onChange={(e) => setLocalPath(e.target.value)}
                  placeholder="/path/to/service/config"
                  className="font-mono text-xs"
                />
                <Button size="sm" variant="outline" type="button" onClick={() => setBrowsing(true)}>
                  <FolderOpen className="h-3.5 w-3.5 mr-1" />
                  Browse
                </Button>
              </div>
            </div>

            {/* Patterns */}
            <div className="space-y-1.5">
              <Label className="text-xs">File Patterns</Label>
              <div className="flex gap-2">
                <Input
                  value={patternInput}
                  onChange={(e) => setPatternInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addPattern();
                    }
                  }}
                  placeholder="e.g. commands/** or settings.json"
                  className="font-mono text-xs"
                />
                <Button
                  size="sm"
                  variant="outline"
                  type="button"
                  onClick={addPattern}
                  disabled={!patternInput.trim()}
                >
                  <Plus className="h-3.5 w-3.5" />
                </Button>
              </div>
              {patterns.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {patterns.map((p) => (
                    <Badge key={p} variant="secondary" className="font-mono text-xs gap-1 pr-1">
                      {p}
                      <button
                        type="button"
                        onClick={() => removePattern(p)}
                        className="ml-0.5 hover:text-destructive"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
              )}
              {patterns.length === 0 && (
                <p className="text-xs text-muted-foreground">
                  Add at least one glob pattern to specify which files to sync.
                </p>
              )}
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={handleSubmit} disabled={!canSubmit}>
                {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
                Add Service
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
