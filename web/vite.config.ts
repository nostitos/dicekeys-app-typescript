import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { viteBuildConstants } from "./vite-build-metadata";

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  root: "./src/",
  // IMPORTANT: base must not be set to a relative path, or when we call; window.history.pushState
  // to update the path, the paths used to import images, workers, and other assets will
  // all break.  This MUST BE hard coded for the web app.
  // Since we deploy the web app off the base URL (https://[staging.]dicekeys.app/) the
  // base path of "/" is used.
  base: "/",
  define: viteBuildConstants(false),
  build: {
    // for debugging
    minify: false,
    // Required for dependency on BigInt and number literals ending in n (1n)
    target: "es2020",
    // Write output into web subdirectory of repository's /dist directory
    outDir: "../../dist/web/",
    // We love source maps for debugging, and since we're open source, there's no reason to hide 'em.
    sourcemap: true,
    
    // Compile the index.html file as the root (not necessary since index.html is default, but useful if this file is branched)
    rollupOptions: {
      input: {
        main: resolve(__dirname, './src/index.html'),
      }
    },
  },  server: {
    port: 3000
  }
})
