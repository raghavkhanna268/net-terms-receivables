/**
 * Gap 3 fixture: Bare ${err} in template literals
 * 
 * The guard should flag error-like identifiers directly in template literals
 * passed to console.*, safeLog, Sentry.captureMessage, or thrown/returned Error.
 * 
 * ${toErrorCode(err)} is allowed.
 */

import * as Sentry from "@sentry/cloudflare";
import { safeLog, toErrorCode } from "~/lib/log.server";

// SHOULD FAIL: Bare ${err} in console.log
export function logBareError(err: Error) {
  console.log(`Failed: ${err}`);
}

// SHOULD FAIL: Bare ${error} in console.error
export function logBareErrorLong(error: Error) {
  console.error(`Operation failed: ${error}`);
}

// SHOULD FAIL: Bare ${e} in console.warn
export function logBareE(e: Error) {
  console.warn(`Warning: ${e}`);
}

// SHOULD FAIL: Bare ${ex} in Sentry.captureMessage
export function logBareExSentry(ex: Error) {
  Sentry.captureMessage(`Exception: ${ex}`, "error");
}

// SHOULD FAIL: Bare ${caught} in thrown error
export function logBareCaughtThrow(caught: Error) {
  throw new Error(`Caught error: ${caught}`);
}

// SHOULD FAIL: Bare ${syncError} in console.log (ends with 'error')
export function logBareSuffixError(syncError: Error) {
  console.log(`Sync failed: ${syncError}`);
}

// SHOULD FAIL: Bare ${parseErr} in console.log (ends with 'err')
export function logBareSuffixErr(parseErr: Error) {
  console.log(`Parse failed: ${parseErr}`);
}

// SHOULD PASS: ${toErrorCode(err)} is safe
export function logToErrorCode(err: Error) {
  console.log(`Failed with code: ${toErrorCode(err)}`);
}

// SHOULD PASS: ${err.name} accessing a safe property
export function logErrorName(err: Error) {
  console.log(`Error type: ${err.name}`);
}

// SHOULD PASS: ${errorCount} is not an error-like identifier
export function logErrorCount(errorCount: number) {
  console.log(`Errors: ${errorCount}`);
}

// SHOULD PASS: ${isError} is a boolean flag prefix
export function logIsError(isError: boolean) {
  console.log(`Is error: ${isError}`);
}
