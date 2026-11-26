/** Same masks as EdgeWatch\Laravel\Redaction\Redactor::scrub(), applied server-side for clients that don't scrub (e.g. laravel/nightwatch). */
export function scrubPii(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\b(?:\d[ -]?){12,18}\d\b/g, '[card]')
    .replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]');
}
