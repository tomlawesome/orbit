import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const [entrypoint, ...arguments_] = process.argv.slice(2);
if (!entrypoint) {
  process.stderr.write("Orbit launcher: a Node.js entrypoint is required.\n");
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
  // The child error may include a path or environment detail; keep launcher
  // output bounded and let the child own its operational diagnostics.
  void error;
  process.stderr.write("Orbit launcher: startup failed.\n");
  process.exitCode = 1;
});

child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
