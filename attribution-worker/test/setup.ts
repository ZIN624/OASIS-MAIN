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

// テストから本物の LINE・Google へ通信しないための止め具。通信はすべて差し替えた fetchImpl を通す。
globalThis.fetch = async () => {
  throw new Error("テストの中で外への通信は禁止です（fetchImpl を差し替えてください）");
};
