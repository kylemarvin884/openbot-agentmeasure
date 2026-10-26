export const EXIT = Object.freeze({ OK: 0, FAIL: 1, USAGE: 2 });

export class AgentmeasureError extends Error {
  constructor(message, { code = "E_INTERNAL", exitCode = EXIT.FAIL } = {}) {
    super(message);
    this.name = "AgentmeasureError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

/** Bad arguments: exit 2. */
export const usageError = (message) =>
  new AgentmeasureError(message, { code: "E_USAGE", exitCode: EXIT.USAGE });

/** Bad input data (schema / missing columns): exit 2, because re-running the same
 *  command with the same file will fail the same way until the data is fixed. */
export const schemaError = (message) =>
  new AgentmeasureError(message, { code: "E_SCHEMA", exitCode: EXIT.USAGE });

/** File could not be read: exit 1. */
export const ioError = (message) => new AgentmeasureError(message, { code: "E_IO", exitCode: EXIT.FAIL });
