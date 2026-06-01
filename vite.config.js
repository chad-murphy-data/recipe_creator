import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { handleClaudeRequest } from "./server/claude.js";

// Dev-only middleware so `npm run dev` serves the same /api/claude endpoint that
// the Netlify function serves in production: password check plus Anthropic proxy,
// both reading server-side env vars (no VITE_ prefix, so never bundled to the client).
function apiDevProxy(env) {
  return {
    name: "api-dev-proxy",
    configureServer(server) {
      server.middlewares.use("/api/claude", async (req, res) => {
        const send = (obj, status) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(obj));
        };
        if (req.method !== "POST") return send({ error: { message: "Method not allowed" } }, 405);

        const password = req.headers["x-app-password"] || "";
        try {
          let raw = "";
          for await (const chunk of req) raw += chunk;
          const { status, data } = await handleClaudeRequest(JSON.parse(raw || "{}"), password, env);
          send(data, status);
        } catch (e) {
          send({ error: { message: String(e?.message ?? e) } }, 502);
        }
      });
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return { plugins: [react(), apiDevProxy(env)] };
});
