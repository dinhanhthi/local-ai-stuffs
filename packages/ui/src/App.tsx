import { useState, useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Toaster } from 'sonner';
import { Layout } from '@/components/layout';
import { DashboardPage } from '@/pages/dashboard';
import { SetupPage } from '@/pages/setup';
import { api } from '@/lib/api';
import { wsClient } from '@/lib/ws';
import { Loader2 } from 'lucide-react';

const RepoDetailPage = lazy(() =>
  import('@/pages/repo-detail').then((m) => ({ default: m.RepoDetailPage })),
);
const ServiceDetailPage = lazy(() =>
  import('@/pages/repo-detail').then((m) => ({ default: m.ServiceDetailPage })),
);
const TemplatesPage = lazy(() =>
  import('@/pages/templates').then((m) => ({ default: m.TemplatesPage })),
);
const SettingsPage = lazy(() =>
  import('@/pages/settings').then((m) => ({ default: m.SettingsPage })),
);
export default function App() {
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [dataDir, setDataDir] = useState<string>();

  useEffect(() => {
    api.setup
      .status()
      .then((res) => {
        setConfigured(res.configured);
        setDataDir(res.dataDir);
      })
      .catch(() => setConfigured(false));
  }, []);

  // Connect WebSocket only when configured
  useEffect(() => {
    if (configured) {
      wsClient.connect();
      return () => wsClient.disconnect();
    }
  }, [configured]);

  if (configured === null) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background">
        <img src="/logo.svg" alt="AI Sync" className="h-14 w-14" />
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Starting server...</span>
        </div>
      </div>
    );
  }

  if (!configured) {
    return <SetupPage />;
  }

  return (
    <BrowserRouter>
      <Layout dataDir={dataDir}>
        <Suspense
          fallback={
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          }
        >
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/repos/:id" element={<RepoDetailPage />} />
            <Route path="/services/:id" element={<ServiceDetailPage />} />
            <Route path="/templates" element={<TemplatesPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </Suspense>
      </Layout>
      <Toaster position="bottom-right" closeButton />
    </BrowserRouter>
  );
}
