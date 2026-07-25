import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const [entrypoint, ...arguments_] = process.argv.slice(2);
if (!entrypoint) {
  console.error("Orbit launcher: a Node.js entrypoint is required.");
  process.exit(1);
}

const environmentFile = resolve(".env-orbit");
if (existsSync(environmentFile)) {
  process.loadEnvFile(environmentFile);
}

const child = spawn(process.execPath, [resolve(entrypoint), ...arguments_], {
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error("Orbit launcher:", error.message);
  process.exitCode = 1;
});

child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
