declare module 'cloudflare:test' {
  interface ProvidedEnv {
    API_KEYS: KVNamespace;
    TRACES: R2Bucket;
  }
}
export {};
