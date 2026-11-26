import { useLocation } from 'react-router-dom';
import { environmentScopedPath } from '@/lib/environment-scope';
import RangePicker from './RangePicker';

/** 1:1 Nightwatch top-right telemetry control: renders ONLY the time range picker (environment lives in the sidebar switcher). */
export default function TelemetryControls() {
  const { pathname } = useLocation();
  const isTelemetryView = environmentScopedPath(pathname);
  if (!isTelemetryView) return null;

  return <RangePicker />;
}
