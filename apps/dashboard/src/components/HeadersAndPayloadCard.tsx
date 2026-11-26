import { CaretDownIcon, CaretUpDownIcon, MagnifyingGlassIcon, WarningIcon } from '@phosphor-icons/react';
import { cn } from '@cloudflare/kumo/utils';
import { useMemo, useState } from 'react';
import { CopyButton, DescriptionList, DescriptionRow, SegmentedToggle } from './common';

const MAX_CAPTURE_BYTES = 65535;

type ParsedHeaders =
  | { kind: 'map'; entries: [string, string[]][]; error?: undefined }
  | { kind: 'raw'; raw: string; error?: undefined }
  | { kind: 'error'; error: string };

function parseHeaders(raw: unknown): ParsedHeaders {
  if (!raw) return { kind: 'map', entries: [] };
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    if (typeof obj._nightwatch_error === 'string') return { kind: 'error', error: obj._nightwatch_error };
    const entries = Object.entries(obj)
      .filter(([k]) => !k.startsWith('_nightwatch_'))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]): [string, string[]] => [k, Array.isArray(v) ? v.map(String) : [String(v ?? '')]]);
    return { kind: 'map', entries };
  }
  const str = String(raw).trim();
  if (!str) return { kind: 'map', entries: [] };
  try {
    const parsed = JSON.parse(str);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parseHeaders(parsed);
    }
    return { kind: 'raw', raw: str };
  } catch {
    return { kind: 'raw', raw: str };
  }
}

type ParsedPayload =
  | { kind: 'empty'; error?: string }
  | { kind: 'raw'; raw: string }
  | { kind: 'json'; data: Record<string, unknown> | unknown[]; files: Record<string, unknown> };

function parsePayload(raw: unknown): ParsedPayload {
  if (raw === null || raw === undefined || raw === '') return { kind: 'empty' };
  if (typeof raw === 'object') {
    if (Array.isArray(raw)) return { kind: 'json', data: raw, files: {} };
    const { _nightwatch_files, _nightwatch_error, ...rest } = raw as Record<string, unknown>;
    if (typeof _nightwatch_error === 'string') return { kind: 'empty', error: _nightwatch_error };
    const files =
      _nightwatch_files && typeof _nightwatch_files === 'object' && !Array.isArray(_nightwatch_files)
        ? (_nightwatch_files as Record<string, unknown>)
        : {};
    return { kind: 'json', data: rest, files };
  }
  const str = String(raw).trim();
  if (!str) return { kind: 'empty' };
  try {
    const parsed = JSON.parse(str);
    if (parsed && typeof parsed === 'object') return parsePayload(parsed);
    return { kind: 'raw', raw: str };
  } catch {
    return { kind: 'raw', raw: str };
  }
}

/** Highlights `[123 bytes redacted]` tokens in muted mono just like Nightwatch `HeadersAndPayloadCard`. */
function RedactedValue({ value }: { value: string }) {
  const parts = value.split(/(\[\d+ bytes redacted\])/g);
  return (
    <>
      {parts.map((part, idx) =>
        /^\[\d+ bytes redacted\]$/.test(part) ? (
          <span key={idx} className="whitespace-nowrap text-neutral-500 dark:text-neutral-400">
            {part}
          </span>
        ) : (
          <span key={idx}>{part}</span>
        ),
      )}
    </>
  );
}

/** Exact Nightwatch expandable `cookie` header row (`$t` in `HeadersAndPayloadCard-JfysE1P8.js`). */
function CookieHeaderRow({ value }: { value: string }) {
  const [expanded, setExpanded] = useState(false);
  const items = value.split(/; /g).filter(Boolean);
  return (
    <div>
      <DescriptionRow label="cookie">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          className="inline-flex items-center gap-1 text-emerald-600 hover:underline dark:text-emerald-500"
        >
          <span>
            {items.length} {items.length === 1 ? 'item' : 'items'}
          </span>
          <CaretDownIcon size={13} className={cn('transition-transform duration-200', expanded && 'rotate-180')} aria-hidden />
        </button>
      </DescriptionRow>
      {expanded && (
        <div className="mt-1.5 overflow-hidden rounded-md border border-neutral-200 dark:border-white/[0.06]">
          {items.map((cookie, idx) => (
            <div
              key={idx}
              className="break-all px-3 py-1.5 font-mono text-xs odd:bg-white even:bg-neutral-50 dark:odd:bg-transparent dark:even:bg-white/[0.02]"
            >
              <RedactedValue value={cookie} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyNotice({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center">
      <div className="flex size-8 items-center justify-center rounded border border-neutral-200 text-neutral-400 dark:border-neutral-800 dark:bg-white/[0.02] dark:text-neutral-600">
        <MagnifyingGlassIcon size={15} aria-hidden />
      </div>
      <p className="mt-3.5 text-base font-semibold text-neutral-900 dark:text-white">{title}</p>
      <p className="mt-2 max-w-sm text-sm font-light text-balance text-neutral-600 dark:text-neutral-400">{description}</p>
    </div>
  );
}

function payloadEmptyCopy(error?: string): { title: string; description: string } {
  switch (error) {
    case 'NOT_ENABLED':
      return {
        title: 'Payload capturing not enabled',
        description: 'Payload capturing is an opt-in feature. Enable NIGHTWATCH_CAPTURE_REQUEST_PAYLOAD in your agent configuration.',
      };
    case 'UNSUPPORTED_CONTENT_TYPE':
      return {
        title: 'No payload found',
        description: 'No payload data available or the payload format is unsupported for this Content-Type.',
      };
    case 'SERIALIZATION_FAILED':
      return {
        title: 'Payload serialization failed',
        description: 'There was an error serializing the payload due to malformed or unserializable data.',
      };
    default:
      return {
        title: 'Payload unavailable',
        description: 'No request payload was captured for this execution.',
      };
  }
}

/**
 * 1:1 Nightwatch `HeadersAndPayloadCard-JfysE1P8.js`:
 * Collapsible card right below the Request Info card with `[Headers | Payload]` toggle,
 * sorted headers list, expandable cookie items, `[N bytes redacted]` highlighting, and JSON/files payload view.
 */
export default function HeadersAndPayloadCard({
  headers,
  payload,
  statusCode,
  method,
}: {
  headers?: unknown;
  payload?: unknown;
  statusCode?: number | null;
  method?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'headers' | 'payload'>('headers');

  const parsedHeaders = useMemo(() => parseHeaders(headers), [headers]);
  const parsedPayload = useMemo(() => parsePayload(payload), [payload]);

  const hasPayloadTab =
    (payload !== undefined && payload !== null && String(payload).trim() !== '') ||
    (Number(statusCode ?? 0) >= 500 && ['POST', 'PUT', 'PATCH'].includes(String(method ?? '').toUpperCase()));

  const headerCount = parsedHeaders.kind === 'map' ? parsedHeaders.entries.reduce((n, [, vals]) => n + vals.length, 0) : 0;

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-md shadow-black/[0.04] transition-colors dark:border-white/[0.06] dark:bg-white/[0.02]',
        !open && 'hover:border-neutral-300 dark:hover:border-white/15',
      )}
    >
      <div className="flex items-center justify-between gap-3 px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-3">
          {hasPayloadTab ? (
            <SegmentedToggle
              value={tab}
              onChange={(next) => {
                setTab(next as 'headers' | 'payload');
                setOpen(true);
              }}
              options={[
                { value: 'headers', label: 'Headers', count: headerCount > 0 ? { value: headerCount, tone: 'default' } : undefined },
                { value: 'payload', label: 'Payload' },
              ]}
            />
          ) : (
            <button
              type="button"
              onClick={() => setOpen((prev) => !prev)}
              className="flex items-center gap-2 text-left text-base font-semibold text-neutral-900 dark:text-white"
            >
              <span>Headers</span>
              {headerCount > 0 && (
                <span className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] font-medium text-neutral-600 dark:bg-white/10 dark:text-neutral-300">
                  {headerCount}
                </span>
              )}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => setOpen((prev) => !prev)}
          aria-expanded={open}
          aria-label={open ? 'Collapse headers and payload' : 'Expand headers and payload'}
          className="flex size-7 items-center justify-center rounded-md border border-neutral-200 bg-white text-neutral-600 transition-colors hover:border-neutral-300 hover:text-neutral-900 dark:border-white/10 dark:bg-white/[0.04] dark:text-neutral-300 dark:hover:border-white/20 dark:hover:text-white"
        >
          <CaretUpDownIcon size={14} aria-hidden />
        </button>
      </div>

      {open && (
        <div className="border-t border-neutral-200/80 px-5 py-4 dark:border-white/[0.06]">
          {tab === 'headers' ? (
            parsedHeaders.kind === 'error' ? (
              <EmptyNotice
                title="Headers serialization failed"
                description="There was an error serializing the headers due to malformed or unserializable data."
              />
            ) : parsedHeaders.kind === 'raw' ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                  <WarningIcon size={14} className="shrink-0" aria-hidden />
                  <span>
                    {parsedHeaders.raw.length === MAX_CAPTURE_BYTES
                      ? `Headers exceeded limit (trimmed to ${MAX_CAPTURE_BYTES.toLocaleString()} bytes)`
                      : 'Headers were unable to be parsed and are displayed as captured'}
                  </span>
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-neutral-200 bg-neutral-50 p-4 font-mono text-xs dark:border-white/[0.06] dark:bg-white/[0.02]">
                  {parsedHeaders.raw}
                </pre>
              </div>
            ) : parsedHeaders.entries.length === 0 ? (
              <EmptyNotice
                title="No headers captured"
                description="No HTTP request headers were attached to this stored trace record."
              />
            ) : (
              <DescriptionList>
                {parsedHeaders.entries.flatMap(([name, values]) =>
                  values.map((val, idx) =>
                    name.toLowerCase() === 'cookie' ? (
                      <CookieHeaderRow key={`${name}-${idx}`} value={val} />
                    ) : (
                      <DescriptionRow key={`${name}-${idx}`} label={name}>
                        <span className="break-all">
                          <RedactedValue value={val} />
                        </span>
                      </DescriptionRow>
                    ),
                  ),
                )}
              </DescriptionList>
            )
          ) : parsedPayload.kind === 'empty' ? (
            <EmptyNotice {...payloadEmptyCopy(parsedPayload.error)} />
          ) : parsedPayload.kind === 'raw' ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                <WarningIcon size={14} className="shrink-0" aria-hidden />
                <span>
                  {parsedPayload.raw.length === MAX_CAPTURE_BYTES
                    ? `Payload exceeded limit (trimmed to ${MAX_CAPTURE_BYTES.toLocaleString()} bytes)`
                    : 'Payload was unable to be parsed and is displayed as captured'}
                </span>
              </div>
              <div className="relative">
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md border border-neutral-200 bg-neutral-50 p-4 pr-12 font-mono text-xs dark:border-white/[0.06] dark:bg-white/[0.02]">
                  {parsedPayload.raw}
                </pre>
                <CopyButton text={parsedPayload.raw} label="Copy payload" className="absolute right-2.5 top-2.5" />
              </div>
            </div>
          ) : (
            <div className={cn('grid gap-4', Object.keys(parsedPayload.files).length > 0 && 'md:grid-cols-2')}>
              <div className="relative">
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md border border-neutral-200 bg-neutral-50 p-4 pr-12 font-mono text-xs leading-6 text-neutral-800 dark:border-white/[0.06] dark:bg-white/[0.02] dark:text-neutral-200">
                  {JSON.stringify(parsedPayload.data, null, 2)}
                </pre>
                <CopyButton
                  text={JSON.stringify(parsedPayload.data, null, 2)}
                  label="Copy payload"
                  className="absolute right-2.5 top-2.5"
                />
              </div>
              {Object.keys(parsedPayload.files).length > 0 && (
                <div className="space-y-1.5">
                  <div className="font-mono text-xs uppercase text-neutral-500 dark:text-neutral-400">Uploaded Files</div>
                  <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-md border border-neutral-200 bg-neutral-50 p-4 font-mono text-xs leading-6 text-neutral-800 dark:border-white/[0.06] dark:bg-white/[0.02] dark:text-neutral-200">
                    {JSON.stringify(parsedPayload.files, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
