import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev-time proxy: the app calls fetch("/chat") as a relative path (see
// StockResearchAssistant.jsx). In dev, Vite serves the frontend on 5173
// and FastAPI runs separately on 8000, so this proxy forwards /chat to
// the backend, keeping the fetch call itself origin-agnostic. In
// production, main.py serves the built frontend AND /chat from the same
// origin, so no proxy or CORS config is needed there.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/chat": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
});
