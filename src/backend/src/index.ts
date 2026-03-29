import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import path from "path";
import fs from "fs";
import { config } from "./config";
import { getDb, closeDb } from "./db/connection";
import { runMigrations } from "./db/schema";
import "./sockets/server";

async function main() {
  console.log(`[boot] Starting Bitwise backend (${config.nodeEnv})`);

  // 1. Connect to DB and run schema migrations
  await getDb();
  await runMigrations();

  // 2. Create Express app
  const app = express();

  // ---------------------------------------------------------------------------
  // Security & logging
  // ---------------------------------------------------------------------------
  app.use(helmet({ contentSecurityPolicy: config.isDev ? false : undefined }));
  app.use(
    cors({
      origin: config.isDev
        ? ["http://localhost:5173", "http://localhost:3000"]
        : ["app://.", "file://"],
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    })
  );
  app.use(morgan(config.isDev ? "dev" : "combined"));

  // ---------------------------------------------------------------------------
  // Body parsing
  // ---------------------------------------------------------------------------
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true }));

  // ---------------------------------------------------------------------------
  // Health check
  // ---------------------------------------------------------------------------
  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      service: "bitwise-backend",
      env: config.nodeEnv,
      ts: Date.now(),
    });
  });

  // ---------------------------------------------------------------------------
  // Static file serving (Electron production build)
  // ---------------------------------------------------------------------------
  if (fs.existsSync(config.static.path)) {
    app.use(express.static(config.static.path));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(config.static.path, "index.html"));
    });
  }

  // ---------------------------------------------------------------------------
  // Start listening
  // ---------------------------------------------------------------------------
  const server = app.listen(config.port, () => {
    console.log(`[boot] Server listening on http://localhost:${config.port}`);
  });

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------
  const shutdown = async (signal: string) => {
    console.log(`\n[shutdown] ${signal} received — shutting down...`);
    server.close(async () => {
      await closeDb();
      console.log("[shutdown] Done. Bye.");
      process.exit(0);
    });
    setTimeout(() => {
      console.error("[shutdown] Timeout — forcing exit");
      process.exit(1);
    }, 10_000);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[boot] Fatal error:", err);
  process.exit(1);
});