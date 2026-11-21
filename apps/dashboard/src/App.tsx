import { Navigate, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import ExceptionDetailPage from './pages/ExceptionDetailPage';
import ExceptionsPage from './pages/ExceptionsPage';
import OverviewPage from './pages/OverviewPage';
import QueriesPage from './pages/QueriesPage';
import QueryDetailPage from './pages/QueryDetailPage';
import SetupPage from './pages/SetupPage';
import TraceDetailPage from './pages/TraceDetailPage';
import TracesPage from './pages/TracesPage';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<OverviewPage />} />
        <Route path="traces" element={<TracesPage />} />
        <Route path="traces/:traceId" element={<TraceDetailPage />} />
        <Route path="exceptions" element={<ExceptionsPage />} />
        <Route path="exceptions/:group" element={<ExceptionDetailPage />} />
        <Route path="queries" element={<QueriesPage />} />
        <Route path="queries/:sqlHash" element={<QueryDetailPage />} />
        <Route path="setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
