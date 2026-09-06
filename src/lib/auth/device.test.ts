import { describe, expect, it } from "vitest";
import { describeDevice } from "./device";

const CHROME_LINUX = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const FIREFOX_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:118.0) Gecko/20100101 Firefox/118.0";
const SAFARI_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15";
const EDGE_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0";
const CHROME_ANDROID = "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Mobile Safari/537.36";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1";
const SAFARI_IPAD = "Mozilla/5.0 (iPad; CPU OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1";
const FIREFOX_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/118.0 Mobile/15E148 Safari/605.1.15";
const CHROME_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/119.0.0.0 Mobile/15E148 Safari/604.1";

describe("describeDevice", () => {
  it.each([
    [CHROME_LINUX, "Chrome · Linux"],
    [FIREFOX_WINDOWS, "Firefox · Windows"],
    [SAFARI_MAC, "Safari · Mac"],
    [EDGE_WINDOWS, "Edge · Windows"],
    [CHROME_ANDROID, "Chrome · Android"],
    [SAFARI_IPHONE, "Safari · iPhone"],
    [SAFARI_IPAD, "Safari · iPad"],
    [FIREFOX_IOS, "Firefox · iPhone"],
    [CHROME_IOS, "Chrome · iPhone"],
  ])("describes %s as %s", (userAgent, expected) => {
    expect(describeDevice(userAgent)).toBe(expected);
  });

  it("reports unknown device for a missing user agent", () => {
    expect(describeDevice(null)).toBe("unknown device");
    expect(describeDevice(undefined)).toBe("unknown device");
    expect(describeDevice("")).toBe("unknown device");
  });

  it("reports unknown device for a string matching neither axis", () => {
    expect(describeDevice("curl/8.0.1")).toBe("unknown device");
  });

  it("reports the axis it does know when only one matches", () => {
    expect(describeDevice("SomeBot/1.0 (Windows NT 10.0)")).toBe("other · Windows");
    expect(describeDevice("Chrome/120.0.0.0 on a made-up platform")).toBe("Chrome · other");
  });

  it("never leaks the raw user agent into the result", () => {
    const userAgent = "Mozilla/5.0 (X11; Linux x86_64; rv:999.0-super-specific-build) Chrome/120.0.0.0 Safari/537.36";
    expect(describeDevice(userAgent)).not.toContain("999.0-super-specific-build");
  });
});
