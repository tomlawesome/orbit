import { describe, expect, it, vi } from "vitest";

import ProgressReporter from "./vitest-progress-reporter.mjs";

/*
 * D1-F3 (#1151): the file header promised a line per test case ("prints the
 * moment each test file and each test case *starts*"), but the reporter
 * only ever implemented the per-file hooks, so a stalled test case was
 * invisible -- the log's last line named the file, not which of its tests
 * was running when everything went quiet. These stand in Vitest's own
 * minimal shape for a TestModule/TestCase rather than running a real
 * Vitest process, since only the reporter's own hooks are under test.
 */

function fakeModule(moduleId, state = "pending") {
  return { moduleId, state: () => state };
}

function fakeTestCase(testModule, fullName, resultState = "passed") {
  return {
    module: testModule,
    fullName,
    result: () => ({ state: resultState }),
  };
}

describe("ProgressReporter", () => {
  it("prints a RUNNING line per file", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const reporter = new ProgressReporter();
    reporter.onTestModuleStart(fakeModule("a.test.mjs"));
    expect(write).toHaveBeenCalledWith("[progress] RUNNING  a.test.mjs\n");
    write.mockRestore();
  });

  it("prints a RUNNING line per test case, naming the test and the file it lives in", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const reporter = new ProgressReporter();
    const testModule = fakeModule("a.test.mjs");
    reporter.onTestCaseReady(fakeTestCase(testModule, "a suite > a hung test"));
    expect(write).toHaveBeenCalledWith("[progress] RUNNING  a.test.mjs :: a suite > a hung test\n");
    write.mockRestore();
  });

  it("prints a DONE line per test case with its own result, not the file's", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const reporter = new ProgressReporter();
    const testModule = fakeModule("a.test.mjs");
    reporter.onTestCaseResult(fakeTestCase(testModule, "a suite > a failing test", "failed"));
    expect(write).toHaveBeenCalledWith("[progress] DONE     a.test.mjs :: a suite > a failing test (failed)\n");
    write.mockRestore();
  });
});
