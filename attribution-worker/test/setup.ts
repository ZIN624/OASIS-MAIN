import { applyD1Migrations, env } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      ATTR_DB: D1Database;
      TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
      ATTR_ROOT_KEY: string;
      ADMIN_TOKEN: string;
    }
  }
}

await applyD1Migrations(env.ATTR_DB, env.TEST_MIGRATIONS);
