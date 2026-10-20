export class OfframpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "OfframpError";
  }
}

export function requireThat(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new OfframpError(code, message);
}

export function publicError(error: unknown) {
  // Never return provider response bodies, CLI output, session tokens or payment payloads.
  return error instanceof OfframpError
    ? { code: error.code, message: error.message }
    : {
        code: "INTERNAL_ERROR",
        message:
          "The operation could not be completed. Check your local configuration; no automatic payment retry was made.",
      };
}
