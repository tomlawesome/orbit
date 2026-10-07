// The install engine's questions to the operator (#1212 build note F4).
//
// install.sh asked its menus through installer-ui.sh on /dev/tty. Since the
// flip every question is the engine's, asked on the terminal install.sh
// passes through to the one-off container (`docker run -t`, #1210 D3), in
// the plain style the configure engine already uses for its own questions:
// a heading, the choices, and a prompt that takes a choice's name, its
// number, or Enter for the default.
//
// Three ways a question can end without an answer, kept apart because the
// installer's exit status says which happened (F4, F8): the operator chose
// to stop (Ctrl-C, Back, Cancel, Exit: 130), the input channel failed (end
// of input: 1), or an answer was refused outright (an invalid local model
// identifier: 2, as install.sh's own `return 2`).

/** The operator's terminal. readLine/readSecret return undefined at end of input and throw InstallPromptStop(130) on Ctrl-C. */
export interface InstallTerminal {
  write(text: string): void;
  readLine(prompt: string): string | undefined;
  readSecret(prompt: string): string | undefined;
}

export type InstallPromptExit = 130 | 1 | 2;

export class InstallPromptStop extends Error {
  readonly exitCode: InstallPromptExit;

  constructor(exitCode: InstallPromptExit, message: string) {
    super(message);
    this.name = "InstallPromptStop";
    this.exitCode = exitCode;
  }
}

export function declined(): InstallPromptStop {
  return new InstallPromptStop(130, "Cancelled; no deployment files or services were changed.");
}

export function inputFailed(): InstallPromptStop {
  return new InstallPromptStop(1, "The terminal closed before an answer was given; no deployment files or services were changed.");
}

/** One labelled choice: the value returned, and the words shown beside it. */
export type InstallChoice = readonly [value: string, label: string];

/**
 * installer_ui_select's job, in plain text: shows the heading and the
 * numbered choices, then asks until it gets one of them. Enter takes the
 * default. End of input is an input failure, never a silent default.
 */
export function selectChoice(terminal: InstallTerminal, heading: string, defaultValue: string, choices: readonly InstallChoice[]): string {
  terminal.write(`\n${heading}\n`);
  choices.forEach(([value, label], index) => {
    terminal.write(`  ${index + 1}) ${label}${value === defaultValue ? " (default)" : ""}\n`);
  });
  const names = choices.map(([value]) => value).join("/");
  for (;;) {
    const answer = terminal.readLine(`Choose [${names}] (default: ${defaultValue}): `);
    if (answer === undefined) throw inputFailed();
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === "") return defaultValue;
    const byName = choices.find(([value]) => value === trimmed);
    if (byName) return byName[0];
    if (/^[1-9][0-9]*$/.test(trimmed) && Number(trimmed) <= choices.length) return choices[Number(trimmed) - 1][0];
    terminal.write(`Enter one of ${names}, or its number.\n`);
  }
}
