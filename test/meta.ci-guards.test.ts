/**
 * Meta-guards so CI regressions that already burned us once cannot return.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createServer } from "vite";

const root = resolve(import.meta.dirname, "..");

describe("CI guards", () => {
  it("default vitest config excludes live tests", () => {
    const src = readFileSync(resolve(root, "vitest.config.ts"), "utf8");
    expect(src).toMatch(/exclude:\s*\[[^\]]*test\/live/);
  });

  it("live vitest config aliases workspace packages to sources", () => {
    const src = readFileSync(resolve(root, "vitest.live.config.ts"), "utf8");
    expect(src).toContain('"@x402-lens/core"');
    expect(src).toContain("packages/core/src/index.ts");
    expect(src).toContain('"@x402-lens/express"');
    expect(src).toContain("packages/express/src/index.ts");
  });

  it("live workflow builds before test:live", () => {
    const src = readFileSync(resolve(root, ".github/workflows/live.yml"), "utf8");
    expect(src).toMatch(/npm run build/);
    expect(src).toMatch(/npm run test:live/);
    const buildAt = src.indexOf("npm run build");
    const testAt = src.indexOf("npm run test:live");
    expect(buildAt).toBeGreaterThan(-1);
    expect(testAt).toBeGreaterThan(buildAt);
  });

  it("resolves @x402-lens/core via live aliases without needing dist", async () => {
    const server = await createServer({
      configFile: false,
      root,
      logLevel: "silent",
      resolve: {
        alias: {
          "@x402-lens/core": resolve(root, "packages/core/src/index.ts"),
          "@x402-lens/express": resolve(root, "packages/express/src/index.ts"),
        },
      },
    });
    try {
      const resolved = await server.pluginContainer.resolveId("@x402-lens/core");
      expect(resolved?.id.replace(/\\/g, "/")).toMatch(/packages\/core\/src\/index\.ts$/);
    } finally {
      await server.close();
    }
  });
});
