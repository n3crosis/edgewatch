import { describe, expect, it } from 'vitest';
import { apiErrorMessage } from './api';

describe('apiErrorMessage', () => {
  it('shows the typed error message and the request id', () => {
    const body = JSON.stringify({ error: { code: 'unavailable', message: 'Storage temporarily unavailable.' }, message: 'Storage temporarily unavailable.', request_id: 'req-1' });
    expect(apiErrorMessage(503, body)).toBe('Storage temporarily unavailable. Request ID: req-1');
  });

  it('falls back to the top-level message', () => {
    expect(apiErrorMessage(401, '{"message":"Unauthenticated."}')).toBe('Unauthenticated.');
  });

  it('never shows a raw non-JSON or unexpected body', () => {
    expect(apiErrorMessage(502, '<html>Bad gateway: upstream 10.0.0.3</html>')).toBe('Request failed (HTTP 502).');
    expect(apiErrorMessage(500, '{"error":{"message":42}}')).toBe('Request failed (HTTP 500).');
    expect(apiErrorMessage(500, 'null')).toBe('Request failed (HTTP 500).');
  });
});
