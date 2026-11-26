/** Pages entry point: keep account cookies and API requests on the dashboard origin. */
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/auth' || path.startsWith('/auth/') || path === '/v1' || path.startsWith('/v1/')) {
      if (!env.API) return Response.json({ error: 'The dashboard API binding is not configured.' }, { status: 503, headers: { 'cache-control': 'no-store' } });
      // A service binding preserves the browser URL, method, cookies and Origin without a public redirect.
      return env.API.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
