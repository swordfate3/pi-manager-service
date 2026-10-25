import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "vite";

const root = import.meta.dirname;
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
if (manifest.name !== "@swordfate/pi-manager" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
  throw new Error("Invalid Manager package metadata");
}
const { createSourceInventory } = await import(pathToFileURL(path.join(root, "scripts/manager-dist.mjs")).href);
const source = await createSourceInventory(root);

export default defineConfig({
  define: {
    __PI_WEB_HUB_METADATA__: JSON.stringify({ version: manifest.version, build: source.sha256 }),
  },
  publicDir: false,
  build: {
    ssr: path.resolve(root, "bin/pi-web-hub.mjs"),
    outDir: "dist/hub",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    rolldownOptions: {
      external: [/^node:/, "ws"],
      output: { format: "esm", entryFileNames: "pi-web-hub.mjs", codeSplitting: false },
    },
  },
});
