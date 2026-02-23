import { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from './confirm-dialog';
import { LinkServiceDialog } from './link-service-dialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { AlertTriangle, Link, Loader2, Monitor, Terminal, Trash2 } from 'lucide-react';
import { api, type UnlinkedStoreService } from '@/lib/api';
import { toast } from 'sonner';

interface UnlinkedServiceCardProps {
  service: UnlinkedStoreService;
  onLinked: () => void;
}

export function UnlinkedServiceCard({ service, onLinked }: UnlinkedServiceCardProps) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const displayName = service.serviceName || service.storeName;

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await api.machines.deleteUnlinkedService(service.storePath);
      toast.success(`Deleted ${displayName} from store`);
      onLinked();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  return (
    <>
      <Card className="border-dashed border-yellow-500/50 bg-yellow-50/30 dark:bg-yellow-950/10">
        <TooltipProvider delayDuration={300}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <div className="flex items-center gap-2 min-w-0">
              <Terminal className="h-4 w-4 text-yellow-600 shrink-0" />
              <CardTitle className="text-sm font-medium truncate">{displayName}</CardTitle>
            </div>
            <Tooltip>
              <TooltipTrigger asChild>
                <AlertTriangle className="h-4 w-4 text-yellow-600 shrink-0" />
              </TooltipTrigger>
              <TooltipContent>Not linked on this machine</TooltipContent>
            </Tooltip>
          </CardHeader>
          <CardContent className="pb-3">
            <p className="text-xs text-muted-foreground font-mono truncate">{service.storePath}</p>
            {service.otherMachines.length > 0 && (
              <div className="mt-2 space-y-0.5">
                {service.otherMachines.slice(0, 2).map((m) => (
                  <div
                    key={m.machineId}
                    className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
                  >
                    <Monitor className="h-3 w-3 shrink-0" />
                    <span className="truncate">
                      {m.machineName}: <span className="font-mono">{m.localPath}</span>
                    </span>
                  </div>
                ))}
                {service.otherMachines.length > 2 && (
                  <p className="text-[11px] text-muted-foreground">
                    +{service.otherMachines.length - 2} more
                  </p>
                )}
              </div>
            )}
          </CardContent>
          <CardFooter className="flex items-center justify-end gap-2 pt-0">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setDeleteOpen(true)}
                  disabled={deleting}
                >
                  {deleting ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Trash2 className="h-3 w-3" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Delete from store</TooltipContent>
            </Tooltip>
            <Button size="sm" variant="outline" onClick={() => setLinkOpen(true)}>
              <Link className="h-3 w-3" />
              Link
            </Button>
          </CardFooter>
        </TooltipProvider>
      </Card>
      <LinkServiceDialog
        open={linkOpen}
        onOpenChange={setLinkOpen}
        onLinked={onLinked}
        service={service}
      />
      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={handleDelete}
        title={`Delete "${displayName}" from store?`}
        description="This will permanently remove the store files and all machine mappings for this service. Local service directories on other machines will not be affected."
        confirmLabel="Delete"
        variant="destructive"
      />
    </>
  );
}
