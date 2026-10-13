import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/*
 * #1371 items 7-9: Orbit's side of the shared door. One host module calls the
 * folder's createDoor; the hand-made port is gone; Orbit's own layers (homes,
 * the sign-in gate, the lockup, the sign-out) ride on the folder's markup.
 * Source tripwires, written from the issue's specification before the code
 * (the shape of tests/unit/arm-single-source.test.mjs). Failures name files.
 *
 * Everything under web/src/lib/door/ is the imported copy (never Orbit's own
 * code), so the scans over "Orbit's source" leave it out.
 */

const root = path.resolve(import.meta.dirname, "../..");
const src = path.join(root, "web/src");
const lib = path.join(src, "lib");
const doorDir = path.join(lib, "door");

const rel = (file) => path.relative(root, file);

const walk = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile() && /\.(js|ts|svelte)$/.test(entry.name))
        .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
    : [];

/* Orbit's own source: everything under web/src except the imported folder */
const orbitSource = walk(src)
  .filter((file) => !file.startsWith(doorDir + path.sep))
  .sort();

const read = (file) => readFileSync(file, "utf8");

/* every module specifier a file imports, re-exports or dynamically imports */
const specifiersOf = (text) => {
  const found = [];
  for (const m of text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)) found.push(m[1]);
  return found;
};

const resolveSpecifier = (file, spec) => {
  if (spec.startsWith("$lib/")) return path.join(lib, spec.slice(5));
  if (spec.startsWith(".")) return path.resolve(path.dirname(file), spec);
  return null;
};

const withoutJs = (p) => p.replace(/\.js$/, "");

describe("one host module for the shared door (item 7)", () => {
  const hostFile = path.join(lib, "door-host.js");

  it("web/src/lib/door-host.js exists", () => {
    expect(existsSync(hostFile), "web/src/lib/door-host.js is missing").toBe(true);
  });

  it("it imports createDoor from $lib/door/index.js", () => {
    const text = existsSync(hostFile) ? read(hostFile) : "";
    expect(text).toMatch(/import\s*\{[^}]*\bcreateDoor\b[^}]*\}\s*from\s*["']\$lib\/door\/index\.js["']/);
  });

  it("it calls createDoor with flags: {}", () => {
    const text = existsSync(hostFile) ? read(hostFile) : "";
    expect(text).toMatch(/createDoor\(\s*\{[\s\S]*\bflags\s*:\s*\{\s*\}/);
  });

  it("its image() map comes from import.meta.glob over ./door/img/**/*.webp", () => {
    const text = existsSync(hostFile) ? read(hostFile) : "";
    expect(text).toMatch(/import\.meta\.glob\(/);
    expect(text).toContain("./door/img/**/*.webp");
    expect(text).toMatch(/\bimage\b/);
  });

  it("the glob excludes dawn/lights-strip-*.webp", () => {
    const text = existsSync(hostFile) ? read(hostFile) : "";
    expect(text).toMatch(/["'`]!(?:[^"'`]*\/)?dawn\/lights-strip-\*\.webp["'`]/);
  });

  it("no other file under web/src calls createDoor: it is the one host module", () => {
    const callers = orbitSource
      .filter((file) => file !== hostFile && /\bcreateDoor\s*\(/.test(read(file)))
      .map(rel);
    expect(callers, `second callers of createDoor:\n${callers.join("\n")}`).toEqual([]);
  });
});

describe("the hand-made port is removed (item 8)", () => {
  const removed = ["engine", "timeline", "voyage", "chores", "first-light", "journey-clock"].map(
    (name) => path.join(lib, "flight", `${name}.js`),
  );

  for (const file of removed) {
    it(`${rel(file)} no longer exists`, () => {
      expect(existsSync(file), `${rel(file)} still exists`).toBe(false);
    });
  }

  it("nothing under web/src (outside the imported folder) imports any of the six", () => {
    const targets = new Set(removed.map(withoutJs));
    const hits = [];
    for (const file of orbitSource) {
      for (const spec of specifiersOf(read(file))) {
        const resolved = resolveSpecifier(file, spec);
        if (resolved && targets.has(withoutJs(resolved))) hits.push(`${rel(file)} imports ${spec}`);
      }
    }
    expect(hits, `imports of removed port files:\n${hits.join("\n")}`).toEqual([]);
  });
});

describe("Orbit's layers on the folder's markup (item 9)", () => {
  it("web/src/lib/flight/homes.js exports othersOf", () => {
    const file = path.join(lib, "flight", "homes.js");
    expect(existsSync(file), "web/src/lib/flight/homes.js is missing").toBe(true);
    const text = read(file);
    expect(text).toMatch(/export\s+(?:async\s+)?(?:const|let|function)\s+othersOf\b|export\s*\{[^}]*\bothersOf\b[^}]*\}/);
  });

  it("homes.js flies other households with homeProps imported from the folder", () => {
    const file = path.join(lib, "flight", "homes.js");
    const text = existsSync(file) ? read(file) : "";
    const imported = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)]
      .filter(([, names]) => /\bhomeProps\b/.test(names))
      .map(([, , spec]) => resolveSpecifier(file, spec))
      .filter(Boolean);
    expect(
      imported.some((p) => p.startsWith(doorDir + path.sep)),
      "homes.js does not import homeProps from web/src/lib/door/",
    ).toBe(true);
    expect(text).toMatch(/\bhomeProps\s*\(\s*homes\s*\)/);
  });

  /* a file of Orbit's own that builds the folder's markup */
  const buildersOf = (pattern) =>
    orbitSource.filter((file) => /\b(?:dawnMarkup|duskMarkup)\b/.test(read(file)) && pattern.test(read(file)));

  it("the sign-in content in the gate slot keeps the live status region (statePrimary / stateSub)", () => {
    const files = buildersOf(/\bstatePrimary\b/).filter((file) => {
      const text = read(file);
      return /\bstateSub\b/.test(text) && /\bgate\b/.test(text) && /aria-live|role=["']status["']/.test(text);
    });
    expect(files.length, "no dawnMarkup caller keeps statePrimary/stateSub in a live region").toBeGreaterThan(0);
  });

  it("the lockup content keeps planet-gold", () => {
    const files = buildersOf(/planet-gold/).filter((file) => /\blockup\b/.test(read(file)));
    expect(files.length, "no dawnMarkup caller passes a lockup carrying planet-gold").toBeGreaterThan(0);
  });

  it("the sign-out wraps duskMarkup() in a <main> with a visually hidden <h1>", () => {
    const files = orbitSource.filter((file) => {
      const text = read(file);
      const main = text.match(/<main\b[^>]*>([\s\S]*?)<\/main>/g) ?? [];
      return main.some((block) => {
        if (!/\bduskMarkup\s*\(/.test(block)) return false;
        const h1 = block.match(/<h1\b[^>]*>/);
        return Boolean(h1) && /sr-only|visually-?hidden|screen-?reader/i.test(h1[0]);
      });
    });
    expect(files.length, "no <main> holds duskMarkup() beside a visually hidden <h1>").toBeGreaterThan(0);
  });
});

/*
 * #1371 stage 2 (items 11-19 and 21): the site's second promotion. Same
 * shape as above: source tripwires written from the issue's specification
 * (notes 33920 and 34970) before the code. Items 20 (type check) and 22
 * (retiring old tests) are not source checks and are not here.
 */

const repoFile = (...parts) => path.join(root, ...parts);

/* every file under a directory, whatever its type, as repo-relative paths */
const walkAny = (dir) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
    : [];

const TEXT_FILE = /\.(?:js|mjs|cjs|ts|svelte|css|json|html|md|yml|yaml|sh|webmanifest|svg|txt)$/;
const isUnderDoor = (file) => file.startsWith(doorDir + path.sep);

/* Orbit's own files of any text type under web/src (the imported folder left out) */
const orbitText = walkAny(src)
  .filter((file) => !isUnderDoor(file) && TEXT_FILE.test(file))
  .sort();

/* the text of the balanced (...) that opens at the "(" at index `open` */
const balanced = (text, open) => {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return text.slice(open);
};

/* the argument text of every call matching `name(` in a file (`name` is a regex source) */
const callsOf = (text, name) =>
  [...text.matchAll(new RegExp(`${name}\\s*\\(`, "g"))].map((m) => balanced(text, m.index + m[0].length - 1));

/* every call of `name` across Orbit's own source, with the file it is in */
const callsAcross = (name) =>
  orbitSource.flatMap((file) => callsOf(read(file), name).map((call) => ({ file, call })));

describe("the GPU is tested on every visit by the folder (item 11)", () => {
  for (const name of ["fitness", "warm"]) {
    const file = path.join(lib, "flight", `${name}.js`);
    it(`${rel(file)} no longer exists`, () => {
      expect(existsSync(file), `${rel(file)} still exists`).toBe(false);
    });
  }

  it("nothing under web/src (outside the imported folder) mentions orbit-flight-fitness", () => {
    const hits = orbitText.filter((file) => read(file).includes("orbit-flight-fitness")).map(rel);
    expect(hits, `files naming the remembered verdict's key:\n${hits.join("\n")}`).toEqual([]);
  });

  it("nothing outside the imported folder imports Orbit's own flight/fitness.js or flight/warm.js", () => {
    const targets = new Set(["fitness", "warm"].map((name) => path.join(lib, "flight", name)));
    const hits = [];
    for (const file of orbitSource) {
      for (const spec of specifiersOf(read(file))) {
        const resolved = resolveSpecifier(file, spec);
        if (resolved && targets.has(withoutJs(resolved))) hits.push(`${rel(file)} imports ${spec}`);
      }
    }
    expect(hits, `imports of removed GPU files:\n${hits.join("\n")}`).toEqual([]);
  });

  it("web/src/lib/gpu.js exists and takes its answer from the folder's index.js", () => {
    const file = path.join(lib, "gpu.js");
    expect(existsSync(file), "web/src/lib/gpu.js is missing").toBe(true);
    const text = existsSync(file) ? read(file) : "";
    const fromFolder = specifiersOf(text)
      .map((spec) => resolveSpecifier(file, spec))
      .filter(Boolean)
      .some((p) => p === path.join(doorDir, "index.js"));
    expect(fromFolder, "gpu.js does not import from web/src/lib/door/index.js").toBe(true);
    expect(text).toMatch(/\bexport\b[^\n]*\bgpu\b|export\s*\{[^}]*\bgpu\b[^}]*\}/);
  });

  it("nothing outside gpu.js reaches into the folder's fitness.js for a GPU answer", () => {
    const hits = [];
    for (const file of orbitSource) {
      if (file === path.join(lib, "gpu.js")) continue;
      for (const spec of specifiersOf(read(file))) {
        const resolved = resolveSpecifier(file, spec);
        if (resolved && withoutJs(resolved) === path.join(doorDir, "fitness")) hits.push(`${rel(file)} imports ${spec}`);
      }
    }
    expect(hits, `direct imports of door/fitness.js:\n${hits.join("\n")}`).toEqual([]);
  });
});

describe("other households fly as homeProps(homes) from the folder (item 12)", () => {
  const homesFile = path.join(lib, "flight", "homes.js");

  it("homes.js imports homeProps from $lib/door/index.js (the folder's entry point)", () => {
    const text = existsSync(homesFile) ? read(homesFile) : "";
    expect(text).toMatch(
      /import\s*\{[^}]*\bhomeProps\b[^}]*\}\s*from\s*["'](?:\$lib\/door\/index\.js|(?:\.\.\/)+door\/index\.js)["']/,
    );
  });

  it("homes.js calls homeProps(homes)", () => {
    const text = existsSync(homesFile) ? read(homesFile) : "";
    expect(text).toMatch(/\bhomeProps\s*\(\s*homes\s*\)/);
  });

  it("no file of Orbit's own defines a homeProps of its own", () => {
    const own = orbitSource
      .filter((file) => /(?:function\s+homeProps\b|(?:const|let|var)\s+homeProps\s*=|export\s*\{[^}]*\bhomeProps\b[^}]*\}\s*;?\s*$)/m.test(read(file)))
      .map(rel);
    expect(own, `Orbit's own homeProps:\n${own.join("\n")}`).toEqual([]);
  });
});

describe("pinned moments use the folder's at option (item 13)", () => {
  it("some file outside the folder calls fly() with an at option", () => {
    const hits = callsAcross("\\.fly").filter(({ call }) => /(?:[{,]\s*|\n\s*)at\s*(?::|,|\})/.test(call));
    expect(hits.length, "no fly(...) call passes an at option").toBeGreaterThan(0);
  });

  it("some file outside the folder calls descend() with an at option", () => {
    const hits = callsAcross("\\.descend").filter(({ call }) => /(?:[{,]\s*|\n\s*)at\s*(?::|,|\})/.test(call));
    expect(hits.length, "no descend(...) call passes an at option").toBeGreaterThan(0);
  });

  it("body.pinned is set around pinned calls", () => {
    const hits = orbitSource.filter((file) =>
      /classList\s*\.\s*(?:add|toggle)\s*\(\s*["']pinned["']/.test(read(file)),
    );
    expect(hits.length, "no file puts the pinned class on the body").toBeGreaterThan(0);
  });

  it("body.pinned is taken off again", () => {
    const hits = orbitSource.filter((file) =>
      /classList\s*\.\s*(?:remove|toggle)\s*\(\s*["']pinned["']/.test(read(file)),
    );
    expect(hits.length, "no file takes the pinned class off the body").toBeGreaterThan(0);
  });
});

describe("the goodbye is the folder's dusk dressed as the dawn (item 14)", () => {
  const duskCalls = () => callsAcross("\\bduskMarkup");
  const asDawnCalls = () => duskCalls().filter(({ call }) => /\basDawn\s*:\s*true\b/.test(call));
  const farewellOf = (call) => {
    const at = call.search(/\bfarewell\s*:\s*\{/);
    if (at < 0) return null;
    const open = call.indexOf("{", at);
    let depth = 0;
    for (let i = open; i < call.length; i += 1) {
      if (call[i] === "{") depth += 1;
      else if (call[i] === "}" && --depth === 0) return call.slice(open, i + 1);
    }
    return call.slice(open);
  };

  it("the sign-out calls duskMarkup with asDawn: true", () => {
    expect(asDawnCalls().length, "no duskMarkup(...) call passes asDawn: true").toBeGreaterThan(0);
  });

  it("that call passes farewell: { said, sub }", () => {
    const farewells = asDawnCalls().map(({ call }) => farewellOf(call)).filter(Boolean);
    expect(farewells.length, "the asDawn duskMarkup call has no farewell object").toBeGreaterThan(0);
    expect(
      farewells.some((f) => /\bsaid\b/.test(f) && /\bsub\b/.test(f)),
      "the farewell object does not carry both said and sub",
    ).toBe(true);
  });

  it("said and sub are plain text: no markup in the farewell, and nothing passed through {@html}", () => {
    const farewells = asDawnCalls().map(({ call }) => farewellOf(call)).filter(Boolean);
    expect(farewells.length, "no farewell object to check").toBeGreaterThan(0);
    for (const f of farewells) {
      expect(f, "a tag inside the farewell text").not.toMatch(/<\/?[a-z][^>]*>/i);
      expect(f, "an HTML-escaping bypass inside the farewell").not.toMatch(/@html|innerHTML/);
    }
  });

  it("the file that builds it keeps the <main> with a visually hidden <h1> (item 9)", () => {
    const files = [...new Set(asDawnCalls().map(({ file }) => file))].filter((file) => {
      const text = read(file);
      const h1 = text.match(/<h1\b[^>]*>/);
      return /<main\b/.test(text) && Boolean(h1) && /sr-only|visually-?hidden|screen-?reader/i.test(h1[0]);
    });
    expect(files.length, "no file with an asDawn duskMarkup call has <main> and a hidden <h1>").toBeGreaterThan(0);
  });
});

describe("households on the descent come from journey.descend({ homes }) (item 15)", () => {
  it("some file outside the folder calls descend() with homes", () => {
    const hits = callsAcross("\\.descend").filter(({ call }) => /\bhomes\b/.test(call));
    expect(hits.length, "no descend(...) call is given homes").toBeGreaterThan(0);
  });

  it("Orbit's own downProfile() is gone: nothing outside the folder mentions it", () => {
    const hits = orbitText.filter((file) => /\bdownProfile\b/.test(read(file))).map(rel);
    expect(hits, `files naming downProfile:\n${hits.join("\n")}`).toEqual([]);
  });
});

describe("leaving the sign-in page calls the dawn's destroy() (item 16)", () => {
  it("some file outside the folder mounts the dawn and calls destroy() on it", () => {
    const hits = orbitSource.filter((file) => {
      const text = read(file);
      return /\.dawn\s*\(|\bmountDawn\s*\(/.test(text) && /\.destroy\s*\(\s*\)/.test(text);
    });
    expect(hits.length, "no file that mounts the dawn calls destroy() on it").toBeGreaterThan(0);
  });

  it("the destroy() runs when the component goes (onDestroy, or the cleanup onMount returns)", () => {
    const hits = orbitSource.filter((file) => {
      const text = read(file);
      if (!/\.dawn\s*\(|\bmountDawn\s*\(/.test(text)) return false;
      const inOnDestroy = callsOf(text, "\\bonDestroy").some((c) => /\.destroy\s*\(\s*\)/.test(c));
      const inOnMount = callsOf(text, "\\bonMount").some((c) => /return[\s\S]*\.destroy\s*\(\s*\)/.test(c));
      return inOnDestroy || inOnMount;
    });
    expect(hits.length, "no destroy() of the dawn sits in onDestroy or an onMount cleanup").toBeGreaterThan(0);
  });
});

describe("the door and the goodbye use the phone layout of the folder (item 17)", () => {
  const phoneCss = path.join(lib, "flight", "door-phone.css");
  const mediaLines = () =>
    (existsSync(phoneCss) ? read(phoneCss) : "").split("\n").filter((line) => /@media/.test(line));
  const text = () => (existsSync(phoneCss) ? read(phoneCss) : "");

  it("door-phone.css exists and has the rule (max-width: 599.98px), (max-height: 479.98px)", () => {
    expect(existsSync(phoneCss), "door-phone.css is missing").toBe(true);
    expect(text()).toMatch(/@media\s*\(\s*max-width\s*:\s*599\.98px\s*\)\s*,\s*\(\s*max-height\s*:\s*479\.98px\s*\)/);
  });

  it("door-phone.css no longer has a (max-width: 900px) query", () => {
    const hits = mediaLines().filter((line) => /max-width\s*:\s*900px/.test(line));
    expect(hits, `old width query:\n${hits.join("\n")}`).toEqual([]);
  });

  it("door-phone.css no longer has a (max-height: 600px) query", () => {
    const hits = mediaLines().filter((line) => /max-height\s*:\s*600px/.test(line));
    expect(hits, `old height query:\n${hits.join("\n")}`).toEqual([]);
  });

  it("the phone rule's reduced-motion variant moved with it: width and height are always paired", () => {
    const widths = (text().match(/max-width\s*:\s*599\.98px/g) ?? []).length;
    const heights = (text().match(/max-height\s*:\s*479\.98px/g) ?? []).length;
    expect(widths, "no 599.98px query in door-phone.css").toBeGreaterThan(0);
    expect(heights).toBe(widths);
  });
});

describe("galaxy-2k.webp is gone (item 18)", () => {
  it("the picture is no longer under web/static or web/src", () => {
    const hits = [...walkAny(path.join(root, "web/static")), ...walkAny(src)]
      .filter((file) => path.basename(file).startsWith("galaxy-2k"))
      .map(rel);
    expect(hits, `galaxy-2k files still present:\n${hits.join("\n")}`).toEqual([]);
  });

  it("nothing under web/src or web/static mentions galaxy-2k", () => {
    const hits = [...walkAny(path.join(root, "web/static")), ...walkAny(src)]
      .filter((file) => TEXT_FILE.test(file) && read(file).includes("galaxy-2k"))
      .map(rel);
    expect(hits, `files naming galaxy-2k:\n${hits.join("\n")}`).toEqual([]);
  });

  it("web/src/lib/about/credits.js has no galaxy-2k entry, and still lists the other pictures", () => {
    const file = path.join(lib, "about", "credits.js");
    expect(existsSync(file), "credits.js is missing").toBe(true);
    const text = read(file);
    expect(text).not.toContain("galaxy-2k");
    expect(text, "the credits list lost its other entries").toContain("moon.webp");
  });
});

describe("scripts/flight-glows.mjs is gone (item 19)", () => {
  it("the script no longer exists", () => {
    expect(existsSync(repoFile("scripts/flight-glows.mjs")), "scripts/flight-glows.mjs still exists").toBe(false);
  });

  it("nothing calls it: package.json, web/package.json, .gitlab-ci.yml, .gitlab/ and scripts/ never name it", () => {
    expect(existsSync(repoFile("package.json")), "package.json not found").toBe(true);
    const files = [
      repoFile("package.json"),
      repoFile("web/package.json"),
      repoFile(".gitlab-ci.yml"),
      ...walkAny(repoFile(".gitlab")),
      ...walkAny(repoFile("scripts")),
    ].filter((file) => existsSync(file) && TEXT_FILE.test(file));
    const hits = files.filter((file) => read(file).includes("flight-glows")).map(rel);
    expect(hits, `files naming flight-glows:\n${hits.join("\n")}`).toEqual([]);
  });
});

describe("the engine-owns-every-rule check skips the imported folder (item 21)", () => {
  const checkFile = repoFile("tests/unit/engine-owns-every-rule.test.mjs");

  it("the check still reads web/src", () => {
    const text = read(checkFile);
    expect(text).toMatch(/web\/src/);
    expect(text).toMatch(/readFileSync/);
  });

  it("it names lib/door as a path it leaves out", () => {
    expect(read(checkFile)).toMatch(/lib[\\/]+door|["'`]lib\/door|["'`]door["'`]/);
  });
});
