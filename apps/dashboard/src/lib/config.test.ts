import { describe, expect, it } from 'vitest';
import { apiConfig } from './config';

describe('apiConfig', () => {
  it('uses seed data without VITE_API_URL', () => {
    expect(apiConfig(undefined)).toEqual({ apiUrl: '', mock: true });
    expect(apiConfig('')).toEqual({ apiUrl: '', mock: true });
  });
  it('treats / as the API on the same origin (single-process server)', () => {
    expect(apiConfig('/')).toEqual({ apiUrl: '', mock: false });
  });
  it('strips a trailing slash from a full URL', () => {
    expect(apiConfig('https://api.example.com/')).toEqual({ apiUrl: 'https://api.example.com', mock: false });
  });
});
