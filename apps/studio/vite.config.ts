import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { viteSingleFile } from "vite-plugin-singlefile";
import { fileURLToPath, URL } from "node:url";

/*
 * Two outputs from one source tree.
 *
 * The default build is the single file: everything inlined, no network at runtime,
 * opens from file:// and works. That is the artifact you hand someone. Chromium
 * treats file:// as a secure context, so Web Serial and Web Bluetooth work there,
 * which is the whole reason these tools ship as one HTML file.
 *
 * BEAM_MULTI=1 produces an ordinary static site for the Pages demo instead.
 */
const single = !process.env.BEAM_MULTI;

export default defineConfig({
  plugins: [vue(), ...(single ? [viteSingleFile()] : [])],
  resolve: {
    alias: {
      "@theme": fileURLToPath(new URL("../../theme", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "es2022",
    /* A stalled asset is worse than a big file here: the point is one artifact. */
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4000,
    rollupOptions: { output: { inlineDynamicImports: single } },
  },
});
