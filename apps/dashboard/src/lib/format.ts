export function ms(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  if (value >= 100) return `${Math.round(value)}ms`;
  return `${value.toFixed(value < 10 ? 2 : 1)}ms`;
}

export function compact(value: number): string {
  return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

export function percent(value: number): string {
  return `${(value * 100).toFixed(value < 0.01 ? 2 : 1)}%`;
}

export function ago(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

export function time(iso: string): string {
  return new Date(iso).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}
