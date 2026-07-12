import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 5173),
    // Portless terminates HTTPS and enforces tailnet exposure before proxying.
    allowedHosts: process.env.PORTLESS_URL ? true : undefined,
  },
});
