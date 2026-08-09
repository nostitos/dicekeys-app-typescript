import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { viteBuildConstants } from "./vite-build-metadata";

const input = resolve(__dirname, "src", "preview.html");
console.log(`preview path`, input);

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  root: "./src/preview",
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
    outDir: "../../dist/preview/",
    // We love source maps for debugging, and since we're open source, there's no reason to hide 'em.
    sourcemap: true,
    
    // Compile the preview.html file as the root
    rollupOptions: {
      input: resolve(__dirname, "src", "preview", "preview.html"),
  //    input: {
  //        main: resolve(__dirname, './src/preview.html'),
  //    }
    },
  }
})
