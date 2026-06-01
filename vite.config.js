import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { handleClaudeRequest, checkPassword } from "./server/claude.js";
import { handleRecipes } from "./server/recipes.js";

// Dev-only middleware so `npm run dev` serves the same /api/* endpoints the
// Netlify functions serve in production: password check, Anthropic proxy, and
// server-side recipes access. All read server-side env vars (no VITE_ prefix,
// so never bundled to the client).
function apiDevProxy(env) {
  return {
    name: "api-dev-proxy",
    configureServer(server) {
      const readBody = async (req) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        return JSON.parse(raw || "{}");
      };
      const sender = (res) => (obj, status) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(obj));
      };

      server.middlewares.use("/api/claude", async (req, res) => {
        const send = sender(res);
        if (req.method !== "POST") return send({ error: { message: "Method not allowed" } }, 405);
        const password = req.headers["x-app-password"] || "";
        try {
          const { status, data } = await handleClaudeRequest(await readBody(req), password, env);
          send(data, status);
        } catch (e) {
          send({ error: { message: String(e?.message ?? e) } }, 502);
        }
      });

      server.middlewares.use("/api/recipes", async (req, res) => {
        const send = sender(res);
        if (req.method !== "POST") return send({ error: { message: "Method not allowed" } }, 405);
        const password = req.headers["x-app-password"] || "";
        const denied = checkPassword(password, env);
        if (denied) return send(denied.data, denied.status);
        try {
          const { status, data } = await handleRecipes(await readBody(req), env);
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
