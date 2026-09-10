import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/*
 * The app's healthcheck timing lives in two places on purpose, and this file
 * is what stops the second one becoming the only one (#923 recommendation 20).
 *
 * Production timing is the Dockerfile's HEALTHCHECK. The repair-journeys
 * harness needs the same probe to fail faster, because its `unhealthy-app`
 * journey waits for Docker to flip a frozen container to `unhealthy` and that
 * flip costs ten consecutive failed probes — two minutes at the production
 * interval. compose/docker-compose.repair-journeys-ci.yml shortens the
 * interval for that throwaway deployment alone.
 *
 * A shortened interval that nobody watches is how the real numbers rot: the
 * override would keep passing whatever the Dockerfile said, and no test would
 * ever sit through the production timing again. So the production values are
 * covered by assertion instead of by waiting — change any of the four numbers
 * below, or widen the override past the interval, and this file fails.
 */
const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);
const overlayName = "compose/docker-compose.repair-journeys-ci.yml";
const overlay = readFileSync(new URL(`../${overlayName}`, import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);
const installScript = readFileSync(new URL("./install.sh", import.meta.url), "utf8").replaceAll(
  "\r\n",
  "\n",
);
const harness = readFileSync(
  new URL("./test-repair-journeys.sh", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");

/** The HEALTHCHECK's flags, without the probe command that follows ` CMD `. */
function healthcheckDirective() {
  const lines = dockerfile.split("\n").filter((line) => line.startsWith("HEALTHCHECK"));
  expect(lines).toHaveLength(1);
  const [line] = lines;
  const command = line.indexOf(" CMD ");
  expect(command).toBeGreaterThan(0);
  return line.slice(0, command);
}

/** The overlay with its comments and blank lines removed. */
function overlayBody() {
  return overlay
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"))
    .join("\n");
}

describe("application healthcheck timing", () => {
  it("keeps the production timing in the Dockerfile, exactly", () => {
    const directive = healthcheckDirective();

    expect(directive).toContain("--interval=10s");
    expect(directive).toContain("--timeout=3s");
    expect(directive).toContain("--start-period=5s");
    expect(directive).toContain("--retries=10");
    // No fifth flag: an added one would change the probe's behaviour without
    // moving any of the four values above, and so would slip past them.
    expect(directive.match(/--[a-z-]+=\S+/gu)).toHaveLength(4);
  });

  it("lets the CI overlay move the interval and nothing else", () => {
    // Compared whole rather than key by key: an extra `timeout` or `retries`
    // here would be a second copy of a production number, free to drift from
    // the Dockerfile while every test still passed. Leaving them out makes
    // Docker merge them from the image, so the journey proves the real probe
    // command, the real 3s timeout and the real ten consecutive failures.
    expect(overlayBody()).toBe(
      ["services:", "  orbit-app:", "    healthcheck:", "      interval: 2s"].join("\n"),
    );
  });

  it("never ships the overlay to an operator", () => {
    // The image carries the deployment assets an install extracts (ADR-0019)
    // and install.sh names them one by one; the overlay is in neither list,
    // so no install.sh run can put it in a real deployment.
    expect(dockerfile).not.toContain(overlayName);
    expect(installScript).not.toContain(overlayName);
  });

  it("applies the overlay through the repair-journeys harness alone", () => {
    // Compose loads `docker-compose.override.yml` automatically beside
    // `docker-compose.yml`, which is how the harness gets the override in
    // front of every later compose call in its throwaway target.
    expect(harness).toContain(overlayName);
    expect(harness).toContain('"$target/docker-compose.override.yml"');
    // The harness verifies the interval it actually got; that guard and the
    // overlay have to name the same number or the run fails for a reason
    // that has nothing to do with repair.
    expect(harness).toContain('[[ "$interval" == 2s ]]');
  });
});
