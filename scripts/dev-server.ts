process.env.CODEX_WEB_PORT ??= "8788";
process.env.CODEX_WEB_LOCAL_ORIGINS ??=
  "http://127.0.0.1:5173,http://127.0.0.1:8788";
await import("../src/server/index");
