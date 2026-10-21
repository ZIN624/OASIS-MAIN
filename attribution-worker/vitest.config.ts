import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: { TEST_MIGRATIONS: migrations, ATTR_ROOT_KEY: "test-root-key-0123456789abcdef0123456789", ADMIN_TOKEN: "test-admin-token-0123456789abcdef0123456789" },
        },
      }),
    ],
    test: { setupFiles: ["./test/setup.ts"] },
  };
});
