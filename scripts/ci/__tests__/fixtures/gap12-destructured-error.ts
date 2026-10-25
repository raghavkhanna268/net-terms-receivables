/**
 * Gap fixture: Destructured { error } from non-error source
 *
 * Even when 'error' is destructured from a result object (not a catch block),
 * logging it directly could still expose sensitive information if the error
 * message contains user/shop data.
 */

import { safeLog } from "~/lib/log.server";

interface ParseResult {
  success: boolean;
  data?: string;
  error?: string;
}

function parseInput(_input: string): ParseResult {
  return { success: false, error: "Parse failed" };
}

function processData(input: string) {
  const result = parseInput(input);

  // SHOULD FAIL: Destructured error logged directly
  // Even though this is from parseInput (not a catch), the guard should flag it
  // because 'error' matches the error-like identifier pattern
  const { error } = result;
  if (error) {
    // This should be flagged as raw-error-arg
    safeLog("info", `Processing failed: ${error}`);
  }

  // OK: Using argError (renamed to avoid false positive)
  const { error: argError } = parseInput(input);
  if (argError) {
    safeLog("info", "Processing failed with error code PARSE_ERROR");
  }

  // SHOULD FAIL: Direct property access to .error
  if (result.error) {
    console.log(`Error: ${result.error}`);
  }
}

export { processData };
