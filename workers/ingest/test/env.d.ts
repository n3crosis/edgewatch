declare global {
  namespace Cloudflare {
    interface Env {
      API_KEYS: KVNamespace;
      TRACES: R2Bucket;
    }
  }
}

export {};
