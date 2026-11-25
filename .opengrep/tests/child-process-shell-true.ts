import { spawn, execFile } from "node:child_process";

export function bad(cmd: string): void {
  // ruleid: child-process-shell-true
  spawn(cmd, [], { shell: true });
  // ruleid: child-process-shell-true
  execFile(cmd, { cwd: "/", shell: true });
}

export function good(file: string): void {
  // ok: child-process-shell-true
  spawn("tar", ["-xf", file], { stdio: "inherit" });
  // ok: child-process-shell-true
  execFile("ls", ["-l"], { shell: false });
}
