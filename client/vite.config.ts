import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/favicon-16.png", "icons/favicon-32.png", "icons/favicon-48.png"],
      manifest: {
        name: "Jose Industries",
        short_name: "Jose Industries",
        description: "Sales, accounts and reports for Jose Enterprises & Jose Industries",
        theme_color: "#16A34A",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
        ],
      },
      workbox: {
        // Workbox's SPA NavigationRoute intercepts every top-level browser
        // navigation (not just fetch/XHR) and serves cached index.html so
        // client-side routes work offline. Without this denylist it also
        // swallows navigations to /api/* - e.g. PDF buttons use
        // window.open(url, "_blank"), which is a real navigation - so the
        // browser tab loaded the cached app shell (Dashboard) instead of
        // ever reaching the PDF route. Excluding /api/ lets those requests
        // fall through to the runtimeCaching rule below (or straight to
        // network).
        navigateFallbackDenylist: [/^\/api\//],
        // This is a business app, not a content site - API data must never
        // be served stale-first. NetworkFirst still lets already-fetched
        // screens render offline (e.g. flaky connectivity on a job site)
        // by falling back to cache only once the network genuinely fails.
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: "NetworkFirst",
            options: {
              cacheName: "api-cache",
              networkTimeoutSeconds: 5,
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  build: {
    outDir: "../public",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
