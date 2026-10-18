export const ExitCode = {
  Ok: 0,
  Error: 1,
  Usage: 2,
} as const;

/** An expected failure: print the message (no stack) and exit with `exitCode`. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = ExitCode.Error,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(message, ExitCode.Usage, hint);
    this.name = 'UsageError';
  }
}
