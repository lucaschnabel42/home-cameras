/// <reference types="vitest/config" />
import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The dev and preview servers send the API paths to a running install of the
// app (its Caddy, which applies the same allow list as production). Set
// CAMERAS_URL to point at another install. Caddy passes the live-view socket
// only from the app's own origin, so the proxy sends that Origin header.
const target = process.env.CAMERAS_URL ?? "http://127.0.0.1:5010";
const upstream: ProxyOptions = { target, changeOrigin: true, headers: { Origin: target } };
const proxy = Object.fromEntries(
  ["/api", "/vod", "/exports", "/clips", "/helper"].map((path) => [path, upstream]),
);
proxy["/live"] = { ...upstream, ws: true };

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { proxy },
  preview: { proxy },
  test: { environment: "node" },
});
