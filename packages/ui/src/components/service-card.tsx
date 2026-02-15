import { SyncItemCard } from './sync-item-card';
import { ServiceSettingsDialog } from './service-settings-dialog';
import { ServiceIcon } from './service-icon';
import { Badge } from '@/components/ui/badge';
import { api, type ServiceSummary } from '@/lib/api';
import { type SizeThresholds, DEFAULT_SIZE_THRESHOLDS } from '@/lib/utils';

interface ServiceCardProps {
  service: ServiceSummary;
  onSync: () => void;
  sizeThresholds?: SizeThresholds;
}

export function ServiceCard({
  service,
  onSync,
  sizeThresholds = DEFAULT_SIZE_THRESHOLDS,
}: ServiceCardProps) {
  return (
    <SyncItemCard
      itemId={service.id}
      itemName={service.name}
      localPath={service.localPath}
      status={service.status}
      syncSummary={service.syncSummary}
      lastSyncedAt={service.lastSyncedAt}
      detailPath={`/services/${service.id}`}
      onSync={onSync}
      sizeThresholds={sizeThresholds}
      apiSync={api.services.sync}
      apiPause={api.services.pause}
      apiResume={api.services.resume}
      apiDelete={api.services.delete}
      deleteTitle="Remove service"
      deleteDescription="Remove this service from tracking? Store files will be kept."
      renderIcon={() => (
        <ServiceIcon
          serviceType={service.serviceType}
          serviceId={service.id}
          iconPath={service.iconPath}
          className="h-4 w-4 text-muted-foreground shrink-0"
        />
      )}
      renderHeaderRight={(statusBadge) => (
        <div className="flex items-center gap-2 shrink-0">
          {service.serviceType.startsWith('custom-') && <Badge variant="secondary">Custom</Badge>}
          {statusBadge}
        </div>
      )}
      renderSettingsDialog={({ open, onOpenChange }) => (
        <ServiceSettingsDialog
          open={open}
          onOpenChange={onOpenChange}
          serviceId={service.id}
          serviceName={service.name}
        />
      )}
    />
  );
}
