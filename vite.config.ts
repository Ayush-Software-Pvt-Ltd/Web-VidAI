import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import { configDefaults, defineConfig } from "vitest/config";
import type { ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Development against the real server: open http://localhost:1420/?backend=http (src/lib/ipc.ts).
// The server (`server/`) speaks only HTTPS with a self-signed certificate, checks that `Origin` is
// its own and sets a `Secure` cookie. The proxy therefore accepts the certificate, presents the
// server's own origin and host, and removes `Secure` from the session cookie (Safari refuses
// Secure cookies on http://localhost). `VIDAI_SERVER` changes the server's address.
const serverTarget = process.env.VIDAI_SERVER || "https://127.0.0.1:14200";
const serverOrigin = new URL(serverTarget).origin;
const toServer = (): ProxyOptions => ({
  target: serverTarget,
  changeOrigin: true,
  secure: false,
  configure: (proxy) => {
    proxy.on("proxyReq", (proxyReq) => {
      if (proxyReq.getHeader("origin")) proxyReq.setHeader("origin", serverOrigin);
    });
    proxy.on("proxyRes", (proxyRes) => {
      const cookies = proxyRes.headers["set-cookie"];
      if (cookies) {
        proxyRes.headers["set-cookie"] = cookies.map((cookie) =>
          cookie.replace(/;\s*Secure\s*(?=;|$)/gi, ""),
        );
      }
    });
  },
});

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },

  server: {
    // A fixed port, so the address in the docs and the bookmarks stays the same; the proxy below
    // carries every call to the server.
    port: 1420,
    strictPort: true,
    // The desktop sources are not part of the page.
    watch: { ignored: ["**/src-tauri/**"] },
    proxy: {
      "^/api/": toServer(),
      "^/p/": toServer(),
      "^/assets/hyperframes-player\\.js$": toServer(),
    },
  },
  build: {
    target: "safari16",
  },

  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    exclude: [...configDefaults.exclude],
    restoreMocks: true,
    css: false,
    // Time limits only catch real hangs, so they must not assume a fast machine. The defaults
    // (5 s per test, 10 s per hook) fail CPU-bound UI tests when the machine is busy or the
    // run is cold (the first run after an install also transforms every module). Waits for
    // the DOM have their own limit in `src/test/setup.ts`, below this one, so a missing
    // element still fails with Testing Library's message instead of a bare timeout.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
