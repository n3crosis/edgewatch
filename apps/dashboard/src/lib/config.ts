/** Without VITE_API_URL the dashboard shows generated seed data and needs no key; `/` means the API on the same origin. */
export function apiConfig(raw: string | undefined): { apiUrl: string; mock: boolean } {
  return { apiUrl: (raw ?? '').replace(/\/$/, ''), mock: !raw };
}
const config = apiConfig(import.meta.env.VITE_API_URL as string | undefined);
export const API_URL = config.apiUrl;
export const USING_MOCK = config.mock;
