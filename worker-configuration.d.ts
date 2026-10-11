interface Env {
  CONCORD_MODE: 'local' | 'production';
  STORAGE_BACKEND: 'fake' | 'bridge' | 'artifacts';
  TENANT_CATALOG: DurableObjectNamespace;
  REPO_COORDINATOR: DurableObjectNamespace;
  ASSETS: Fetcher;
  ARTIFACTS?: Artifacts;
  AUTH_TOKENS?: string;
  TRUSTED_CONFIG?: string;
  BRIDGE_URL?: string;
  CONCORD_TEST_NOW?: string;
}

declare module 'cloudflare:workers' {
  interface ProvidedEnv extends Env {}
}

declare namespace Cloudflare {
  interface Env {
    CONCORD_MODE: 'local' | 'production';
    STORAGE_BACKEND: 'fake' | 'bridge' | 'artifacts';
    TENANT_CATALOG: DurableObjectNamespace;
    REPO_COORDINATOR: DurableObjectNamespace;
    ASSETS: Fetcher;
    ARTIFACTS?: Artifacts;
  }
}
