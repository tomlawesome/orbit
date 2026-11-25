import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// #1354 part 2: source check that desk and pocket share acts.js.
describe("both shapes use the shared module", () => {
  const dir = new URL("../../web/src/routes/household/%5Bid%5D/", import.meta.url);
  const read = (name) => readFileSync(new URL(name, dir), "utf8");
  const shapes = ["+page.svelte", "pocket.svelte"];

  it.each(shapes)("%s imports from ./acts.js", (file) => {
    expect(read(file)).toMatch(/from\s+["']\.\/acts\.js["']/);
  });

  it.each(shapes)("%s no longer defines the acts itself", (file) => {
    const src = read(file);
    for (const name of ["ownerLeave", "act", "handOver", "decide", "offer", "nameOk"]) {
      const own = new RegExp(`(?:function\\s+${name}\\s*\\(|(?:const|let)\\s+${name}\\s*=)`);
      expect(src, `${file} defines ${name}`).not.toMatch(own);
    }
  });

  it.each(shapes)("%s no longer calls the server for these acts directly", (file) => {
    const src = read(file);
    for (const call of ["transferOwnership(", "decideJoinRequest(", "sendInvitation("]) {
      expect(src, `${file} calls ${call}`).not.toContain(call);
    }
  });
});
