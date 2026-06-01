import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { callAnthropic } from "./server/claude.js";

// Dev-only middleware so `npm run dev` serves the same /api/claude proxy that
// the Netlify function serves in production. The Anthropic key is read from a
// server-side env var (ANTHROPIC_API_KEY, no VITE_ prefix) and is never bundled
// into client code.
function anthropicDevProxy(env) {
  return {
    name: "anthropic-dev-proxy",
    configureServer(server) {
      server.middlewares.use("/api/claude", async (req, res) => {
        const send = (obj, status) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(obj));
        };
        if (req.method !== "POST") return send({ error: { message: "Method not allowed" } }, 405);

        const apiKey = env.ANTHROPIC_API_KEY;
        if (!apiKey) return send({ error: { message: "ANTHROPIC_API_KEY is not set in .env" } }, 500);

        try {
          let raw = "";
          for await (const chunk of req) raw += chunk;
          const { status, data } = await callAnthropic(JSON.parse(raw || "{}"), apiKey);
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
  return { plugins: [react(), anthropicDevProxy(env)] };
});
