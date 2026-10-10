import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * #1342: one arming implementation, one timeout (web/src/lib/arm.js, 4 s).
 * No screen keeps its own copy. Source tripwires; failures list file:line.
 */

const root = path.resolve(import.meta.dirname, "../..");

const listed = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch (error) {
    if (error.status === 1) return []; /* grep: no match */
    throw error;
  }
};

const svelteFiles = listed("find", ["web/src", "-name", "*.svelte", "-type", "f"]).sort();

describe("one arming implementation", () => {
  it("nothing under web/src imports pocket/arm", () => {
    const hits = listed("grep", ["-rnE", "pocket/arm", "web/src"]);
    expect(hits, `still names pocket/arm:\n${hits.join("\n")}`).toEqual([]);
  });

  it("no .svelte file keeps its own arm timer: no setTimeout( with 'arm' within 3 lines", () => {
    const found = [];
    for (const file of svelteFiles) {
      const lines = readFileSync(path.join(root, file), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!line.includes("setTimeout(")) return;
        /* a short literal delay (a 150 ms close, a 30 ms paint) is not a hold */
        const delay = line.match(/,\s*(\d[\d_]*)\s*\)\s*;?\s*$/);
        if (delay && Number(delay[1].replaceAll("_", "")) < 1000) return;
        const around = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
        /* "arm", "armed", "Arm" inside a camelCase name, "disarm"; not "alarm" or "harm" */
        if (/\barm|[a-z]Arm|disarm/i.test(around.replace(/\b(al|ch|h|f|w)arm/gi, ""))) found.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(found, `inline arm timers:\n${found.join("\n")}`).toEqual([]);
  });

  it("no .svelte file spells a 4 s or 5 s hold as a literal", () => {
    const found = [];
    for (const file of svelteFiles) {
      readFileSync(path.join(root, file), "utf8").split("\n").forEach((line, i) => {
        if (/\b(4000|5000|4_000|5_000)\b/.test(line)) found.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(found, `literal 4000/5000:\n${found.join("\n")}`).toEqual([]);
  });
});
