import { useState, useEffect } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { api, type AvailableService } from '@/lib/api';
import { Check, Plus, Loader2, Settings2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { ServiceIcon } from './service-icon';
import { AddCustomServiceDialog } from './add-custom-service-dialog';

interface AddServiceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: () => void;
}

export function AddServiceDialog({ open, onOpenChange, onAdded }: AddServiceDialogProps) {
  const [available, setAvailable] = useState<AvailableService[]>([]);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);

  useEffect(() => {
    if (open) {
      setLoading(true);
      api.services
        .available()
        .then((data) => setAvailable(data.services))
        .catch(() => setAvailable([]))
        .finally(() => setLoading(false));
    }
  }, [open]);

  const handleAdd = async (serviceType: string) => {
    setAdding(serviceType);
    try {
      await api.services.create(serviceType);
      onAdded();
      onOpenChange(false);
    } catch {
      // Error handled by api client
    } finally {
      setAdding(null);
    }
  };

  const handleCustomAdded = () => {
    onAdded();
    onOpenChange(false);
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add AI Service</DialogTitle>
            <DialogDescription>Sync configuration files from local AI services.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {loading ? (
              <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Loading available services...
              </div>
            ) : available.length === 0 ? (
              <div className="text-center py-8 text-sm text-muted-foreground">
                No available services found.
              </div>
            ) : (
              available.map((svc) => (
                <div
                  key={svc.serviceType}
                  className="flex items-center justify-between rounded-lg border p-4"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <ServiceIcon
                      serviceType={svc.serviceType}
                      className="h-5 w-5 text-muted-foreground shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 font-medium text-sm">
                        <span>{svc.name}</span>
                        {svc.serviceType.startsWith('custom-') ? (
                          <Badge variant="secondary">Custom</Badge>
                        ) : svc.detected ? (
                          <Badge variant="success">Detected</Badge>
                        ) : (
                          <Badge variant="outline">Not detected</Badge>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground font-mono truncate">
                        {svc.defaultPath}
                      </div>
                    </div>
                  </div>
                  <div className="shrink-0 ml-3">
                    {svc.registered ? (
                      <Button size="sm" variant="outline" disabled>
                        <Check className="h-3.5 w-3.5 mr-1" />
                        Added
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => handleAdd(svc.serviceType)}
                        disabled={
                          adding !== null ||
                          (!svc.detected && !svc.serviceType.startsWith('custom-'))
                        }
                      >
                        {adding === svc.serviceType ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />
                        ) : (
                          <Plus className="h-3.5 w-3.5 mr-1" />
                        )}
                        Add
                      </Button>
                    )}
                  </div>
                </div>
              ))
            )}

            {/* Add Custom Service */}
            {!loading && (
              <div className="border-t pt-3">
                <Button variant="outline" className="w-full" onClick={() => setCustomOpen(true)}>
                  <Settings2 className="h-4 w-4 mr-2" />
                  Add Custom Service
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AddCustomServiceDialog
        open={customOpen}
        onOpenChange={setCustomOpen}
        onAdded={handleCustomAdded}
        existingServices={available}
      />
    </>
  );
}
