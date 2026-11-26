import { BroadcastIcon } from '@phosphor-icons/react';
import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import KeyGate from './components/KeyGate';
import PageBoundary from './components/PageBoundary';
import { EVENT_PAGES } from './lib/events';

const AccountsPage = lazy(() => import('./pages/AccountsPage'));
const Layout = lazy(() => import('./components/Layout'));
const ExceptionDetailPage = lazy(() => import('./pages/ExceptionDetailPage'));
const ExceptionsPage = lazy(() => import('./pages/ExceptionsPage'));
const LogsPage = lazy(() => import('./pages/LogsPage'));
const RequestsPage = lazy(() => import('./pages/RequestsPage'));
const OverviewPage = lazy(() => import('./pages/OverviewPage'));
const PipelinePage = lazy(() => import('./pages/PipelinePage'));
const QueriesPage = lazy(() => import('./pages/QueriesPage'));
const QueryDetailPage = lazy(() => import('./pages/QueryDetailPage'));
const SetupPage = lazy(() => import('./pages/SetupPage'));
const TraceDetailPage = lazy(() => import('./pages/TraceDetailPage'));
const TracesPage = lazy(() => import('./pages/TracesPage'));
const EventDetailPage = lazy(() => import('./pages/EventDetailPage'));
const EventsPage = lazy(() => import('./pages/EventsPage'));
const IssuesPage = lazy(() => import('./pages/IssuesPage'));
const IssueDetailPage = lazy(() => import('./pages/IssuesPage').then((module) => ({ default: module.IssueDetailPage })));

export default function App() {
  return (
    <Routes>
      <Route
        element={
          <KeyGate>
            <PageBoundary>
              <Suspense
                fallback={
                  <div role="status" className="grid min-h-full place-items-center p-6">
                    <div className="flex flex-col items-center gap-3 text-sm text-kumo-subtle">
                      <div className="grid size-10 place-items-center rounded-xl bg-kumo-brand text-white shadow-xs">
                        <BroadcastIcon size={20} weight="bold" />
                      </div>
                      <span>Loading dashboard…</span>
                    </div>
                  </div>
                }
              >
                <Layout />
              </Suspense>
            </PageBoundary>
          </KeyGate>
        }
      >
        <Route index element={<OverviewPage />} />
        <Route path="issues" element={<IssuesPage />} />
        <Route path="issues/:group" element={<IssueDetailPage />} />
        <Route path="logs" element={<LogsPage />} />
        <Route path="requests" element={<RequestsPage />} />
        <Route path="traces" element={<TracesPage />} />
        <Route path="traces/:traceId" element={<TraceDetailPage />} />
        <Route path="exceptions" element={<ExceptionsPage />} />
        <Route path="exceptions/:group" element={<ExceptionDetailPage />} />
        <Route path="queries" element={<QueriesPage />} />
        <Route path="queries/:sqlHash" element={<QueryDetailPage />} />
        {EVENT_PAGES.flatMap((page) => [
          ...(page.path === "/logs" ? [] : [<Route key={page.path} path={page.path.slice(1)} element={<EventsPage key={page.path} page={page} />} />]),
          <Route key={`${page.path}/:key`} path={`${page.path.slice(1)}/:key`} element={<EventDetailPage page={page} />} />,
        ])}
        <Route path="pipeline" element={<PipelinePage />} />
        <Route path="accounts" element={<AccountsPage />} />
        <Route path="setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
