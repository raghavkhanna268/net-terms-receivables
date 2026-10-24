/**
 * P3.9: raw-capture should catch any catch-clause variable
 *
 * Not just err/error, but e, caught, exception, etc.
 */

import { captureException } from "~/lib/sentry";

// SHOULD FAIL: err
export function captureErr() {
  try {
    throw new Error("test");
  } catch (err) {
    captureException(err);
  }
}

// SHOULD FAIL: error
export function captureError() {
  try {
    throw new Error("test");
  } catch (error) {
    captureException(error);
  }
}

// SHOULD FAIL: e
export function captureE() {
  try {
    throw new Error("test");
  } catch (e) {
    captureException(e);
  }
}

// SHOULD FAIL: caught
export function captureCaught() {
  try {
    throw new Error("test");
  } catch (caught) {
    captureException(caught);
  }
}

// SHOULD FAIL: exception
export function captureExc() {
  try {
    throw new Error("test");
  } catch (exception) {
    captureException(exception);
  }
}

// SHOULD PASS: captureExceptionWithTags
function captureExceptionWithTags(_e: unknown, _t: Record<string, string>) {}

export function captureSafe() {
  try {
    throw new Error("test");
  } catch (err) {
    captureExceptionWithTags(err, { code: "test_error" });
  }
}
