import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
    base: './',
    root: resolve(import.meta.dirname, 'src'),
    build: {
        outDir: resolve(import.meta.dirname, 'dist')
    }
});
