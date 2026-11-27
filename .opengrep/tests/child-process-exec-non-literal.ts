import { exec, execSync as run } from "node:child_process";
import * as cp from "child_process";

export function bad(name: string): void {
  // ruleid: child-process-exec-non-literal
  exec(`git log ${name}`);
  // ruleid: child-process-exec-non-literal
  run("ls " + name);
  // ruleid: child-process-exec-non-literal
  cp.execSync(name, { stdio: "inherit" });
}

export function good(name: string): void {
  // ok: child-process-exec-non-literal
  exec("git status");
  // ok: child-process-exec-non-literal
  cp.execFileSync("git", ["log", name]);
  // ok: child-process-exec-non-literal
  /a(b)/.exec(name);
}

const childProcess = require("child_process");

export function badRequire(cmd: string): void {
  // ruleid: child-process-exec-non-literal
  childProcess.exec(cmd);
}

export function goodRequire(): void {
  // ok: child-process-exec-non-literal
  childProcess.exec("uptime");
}

const { execSync } = require("node:child_process");

export function badDestructured(cmd: string): Buffer {
  // ruleid: child-process-exec-non-literal
  return execSync(cmd);
}
