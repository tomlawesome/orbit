import { describe, expect, it } from "vitest";

import {
  IMPORT_CONFIRMATION_PHRASE,
  type MachinePromptDriver,
  RESTORE_CONFIRMATION_PHRASE,
  RecoveryPromptAbortedError,
  classifyLiteralConfirmationRejection,
  classifyPassphraseConfirmationRejection,
  classifyRecoveryPassphraseRejection,
  collectMachineImportConfirmation,
  collectMachinePromptField,
  collectMachineRecoveryPassphrase,
  collectMachineRecoveryPassphraseNoConfirm,
  collectMachineRestoreConfirmation,
  recoveryPromptFieldKind,
  validateImportConfirmation,
  validatePassphraseConfirmation,
  validateRecoveryPassphrase,
  validateRestoreConfirmation,
} from "./recovery-prompts";

// The recovery-bundle/restore machine-prompt protocol (issue #296 slice 4),
// extending docs/engine-events.md's existing "Machine prompts (v0)"
// vocabulary. Mirrors the spirit of scripts/engine-prompts.test.mjs (which
// exercises configure.sh's own machine-prompt grammar), but pure-TS and
// injected-I/O — no subprocess needed for the protocol logic itself.

function scriptedDriver(answers: readonly (string | undefined)[]): { driver: MachinePromptDriver; lines: string[] } {
  const lines: string[] = [];
  let index = 0;
  return {
    lines,
    driver: {
      write(line: string): void {
        lines.push(line);
      },
      readLine(): string | undefined {
        return answers[index++];
      },
    },
  };
}

describe("recoveryPromptFieldKind", () => {
  it("RECOVERY_PASSPHRASE and RECOVERY_PASSPHRASE_CONFIRM are kind=secret", () => {
    expect(recoveryPromptFieldKind("RECOVERY_PASSPHRASE")).toBe("secret");
    expect(recoveryPromptFieldKind("RECOVERY_PASSPHRASE_CONFIRM")).toBe("secret");
  });

  it("IMPORT_CONFIRMATION and RESTORE_CONFIRMATION are kind=text", () => {
    expect(recoveryPromptFieldKind("IMPORT_CONFIRMATION")).toBe("text");
    expect(recoveryPromptFieldKind("RESTORE_CONFIRMATION")).toBe("text");
  });
});

describe("validators (export-recovery-bundle.sh #6-7, import-recovery-bundle.sh #19, restore.sh #46)", () => {
  it("validateRecoveryPassphrase accepts >=12 chars, rejects shorter", () => {
    expect(validateRecoveryPassphrase("a".repeat(12))).toBe("a".repeat(12));
    expect(validateRecoveryPassphrase("a".repeat(11))).toBeUndefined();
    expect(validateRecoveryPassphrase("")).toBeUndefined();
  });

  it("validatePassphraseConfirmation accepts only an exact match", () => {
    const validate = validatePassphraseConfirmation("correct horse battery staple");
    expect(validate("correct horse battery staple")).toBe("correct horse battery staple");
    expect(validate("wrong")).toBeUndefined();
  });

  it("validateImportConfirmation accepts only the literal phrase", () => {
    expect(validateImportConfirmation(IMPORT_CONFIRMATION_PHRASE)).toBe(IMPORT_CONFIRMATION_PHRASE);
    expect(validateImportConfirmation("import recovery")).toBeUndefined();
    expect(validateImportConfirmation("IMPORT RECOVERY ")).toBeUndefined();
  });

  it("validateRestoreConfirmation accepts only the literal phrase", () => {
    expect(validateRestoreConfirmation(RESTORE_CONFIRMATION_PHRASE)).toBe(RESTORE_CONFIRMATION_PHRASE);
    expect(validateRestoreConfirmation("restore")).toBeUndefined();
    expect(validateRestoreConfirmation("RESTORE\n")).toBeUndefined();
  });
});

describe("reason classification (diagnostic-only; never itself decides acceptance)", () => {
  it("classifyRecoveryPassphraseRejection: empty vs. too-short", () => {
    expect(classifyRecoveryPassphraseRejection("")).toBe("empty");
    expect(classifyRecoveryPassphraseRejection("short")).toBe("too-short");
  });

  it("classifyPassphraseConfirmationRejection: empty vs. mismatch", () => {
    expect(classifyPassphraseConfirmationRejection("")).toBe("empty");
    expect(classifyPassphraseConfirmationRejection("nope")).toBe("mismatch");
  });

  it("classifyLiteralConfirmationRejection: empty vs. no-match", () => {
    expect(classifyLiteralConfirmationRejection("")).toBe("empty");
    expect(classifyLiteralConfirmationRejection("nope")).toBe("no-match");
  });
});

describe("collectMachinePromptField line grammar (docs/engine-events.md)", () => {
  it("emits prompt then prompt-accept on a valid first answer", () => {
    const { driver, lines } = scriptedDriver(["a".repeat(12)]);
    const value = collectMachinePromptField({
      field: "RECOVERY_PASSPHRASE",
      driver,
      validate: validateRecoveryPassphrase,
      classifyRejection: classifyRecoveryPassphraseRejection,
    });
    expect(value).toBe("a".repeat(12));
    expect(lines).toEqual(["prompt field=RECOVERY_PASSPHRASE kind=secret required=true attempt=1", "prompt-accept field=RECOVERY_PASSPHRASE"]);
  });

  it("retries up to 3 attempts, incrementing attempt=, before aborting", () => {
    const { driver, lines } = scriptedDriver(["short", "still-short", "nope"]);
    expect(() =>
      collectMachinePromptField({
        field: "RECOVERY_PASSPHRASE",
        driver,
        validate: validateRecoveryPassphrase,
        classifyRejection: classifyRecoveryPassphraseRejection,
      }),
    ).toThrow(RecoveryPromptAbortedError);
    expect(lines).toEqual([
      "prompt field=RECOVERY_PASSPHRASE kind=secret required=true attempt=1",
      "prompt-reject field=RECOVERY_PASSPHRASE reason=too-short",
      "prompt field=RECOVERY_PASSPHRASE kind=secret required=true attempt=2",
      "prompt-reject field=RECOVERY_PASSPHRASE reason=too-short",
      "prompt field=RECOVERY_PASSPHRASE kind=secret required=true attempt=3",
      "prompt-reject field=RECOVERY_PASSPHRASE reason=too-short",
      "prompt-abort field=RECOVERY_PASSPHRASE",
    ]);
  });

  it("recovers on the 3rd attempt after 2 rejections", () => {
    const { driver } = scriptedDriver(["", "short", "a".repeat(12)]);
    const value = collectMachinePromptField({
      field: "RECOVERY_PASSPHRASE",
      driver,
      validate: validateRecoveryPassphrase,
      classifyRejection: classifyRecoveryPassphraseRejection,
    });
    expect(value).toBe("a".repeat(12));
  });

  it("aborts immediately on end-of-input (no fourth prompt, matching configure.sh's own end-of-input handling)", () => {
    const { driver, lines } = scriptedDriver([]);
    expect(() =>
      collectMachinePromptField({
        field: "RESTORE_CONFIRMATION",
        driver,
        validate: validateRestoreConfirmation,
        classifyRejection: classifyLiteralConfirmationRejection,
      }),
    ).toThrow(RecoveryPromptAbortedError);
    expect(lines).toEqual(["prompt field=RESTORE_CONFIRMATION kind=text required=true attempt=1", "prompt-abort field=RESTORE_CONFIRMATION"]);
  });

  it("never emits the prompted value itself in any protocol line, for a secret-kind field", () => {
    const secret = "super-secret-passphrase-value";
    const { driver, lines } = scriptedDriver([secret]);
    collectMachinePromptField({
      field: "RECOVERY_PASSPHRASE",
      driver,
      validate: validateRecoveryPassphrase,
      classifyRejection: classifyRecoveryPassphraseRejection,
    });
    for (const line of lines) expect(line).not.toContain(secret);
  });
});

describe("collectMachineRecoveryPassphrase (export-recovery-bundle.sh's read-then-confirm ordering)", () => {
  it("collects RECOVERY_PASSPHRASE then RECOVERY_PASSPHRASE_CONFIRM in order", () => {
    const passphrase = "a".repeat(12);
    const { driver, lines } = scriptedDriver([passphrase, passphrase]);
    expect(collectMachineRecoveryPassphrase(driver)).toBe(passphrase);
    expect(lines[0]).toContain("field=RECOVERY_PASSPHRASE ");
    expect(lines).toContain("prompt-accept field=RECOVERY_PASSPHRASE");
    expect(lines.some((line) => line.startsWith("prompt field=RECOVERY_PASSPHRASE_CONFIRM"))).toBe(true);
    expect(lines).toContain("prompt-accept field=RECOVERY_PASSPHRASE_CONFIRM");
  });

  it("rejects a mismatched confirmation", () => {
    const { driver } = scriptedDriver(["a".repeat(12), "b".repeat(12), "b".repeat(12), "b".repeat(12)]);
    // First confirm attempt mismatches (rejected x3) -> abort.
    expect(() => collectMachineRecoveryPassphrase(driver)).toThrow(RecoveryPromptAbortedError);
  });
});

describe("collectMachineRecoveryPassphraseNoConfirm (import-recovery-bundle.sh: no confirmation entry)", () => {
  it("collects only RECOVERY_PASSPHRASE", () => {
    const passphrase = "a".repeat(12);
    const { driver, lines } = scriptedDriver([passphrase]);
    expect(collectMachineRecoveryPassphraseNoConfirm(driver)).toBe(passphrase);
    expect(lines.some((line) => line.includes("RECOVERY_PASSPHRASE_CONFIRM"))).toBe(false);
  });
});

describe("collectMachineImportConfirmation / collectMachineRestoreConfirmation", () => {
  it("accepts the exact IMPORT RECOVERY phrase", () => {
    const { driver } = scriptedDriver([IMPORT_CONFIRMATION_PHRASE]);
    expect(() => collectMachineImportConfirmation(driver)).not.toThrow();
  });

  it("accepts the exact RESTORE phrase", () => {
    const { driver } = scriptedDriver([RESTORE_CONFIRMATION_PHRASE]);
    expect(() => collectMachineRestoreConfirmation(driver)).not.toThrow();
  });

  it("aborts on a wrong phrase after 3 attempts", () => {
    const { driver } = scriptedDriver(["restore", "Restore", "RESTORE!"]);
    expect(() => collectMachineRestoreConfirmation(driver)).toThrow(RecoveryPromptAbortedError);
  });
});
