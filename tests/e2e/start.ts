import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const directory = await mkdtemp(path.join(tmpdir(), "codex-web-e2e-"));
const executable = path.join(directory, process.platform === "win32" ? "fake-codex.exe" : "fake-codex");
const buildFake = Bun.spawn(
  ["bun", "build", "tests/fixtures/fake-codex.ts", "--compile", "--outfile", executable],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await buildFake.exited) !== 0) process.exit(1);
const buildUi = Bun.spawn(["bun", "run", "build"], { stdout: "inherit", stderr: "inherit" });
if ((await buildUi.exited) !== 0) process.exit(1);

const server = Bun.spawn(["bun", "src/server/index.ts"], {
  env: { ...process.env, CODEX_WEB_CODEX_EXECUTABLE: executable },
  stdout: "inherit",
  stderr: "inherit",
});

async function stop(): Promise<void> {
  server.kill("SIGTERM");
  await server.exited;
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
process.exitCode = await server.exited;
await rm(directory, { recursive: true, force: true });
