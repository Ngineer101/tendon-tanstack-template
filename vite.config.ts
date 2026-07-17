import { defineConfig } from "vite-plus";
import type { PluginOption } from "vite";
import { devtools } from "@tanstack/devtools-vite";

import { tanstackStart } from "@tanstack/react-start/plugin/vite";

import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { cloudflare } from "@cloudflare/vite-plugin";

const isVitest = !!process.env.VITEST;

const plugins: PluginOption[] = [
  devtools(),
  ...(isVitest ? [] : [cloudflare({ viteEnvironment: { name: "ssr" } })]),
  tailwindcss(),
  tanstackStart(),
  viteReact(),
];

const config = defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: { ignorePatterns: ["src/routeTree.gen.ts"] },
  resolve: { tsconfigPaths: true },
  plugins,
  test: {
    include: ["src/**/__tests__/**/*.test.{ts,tsx}"],
  },
});

export default config;
