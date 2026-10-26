# Sanitized top-level GraphQL error codes of one Admin API response.
#
# Prints a single line:
#   none          when the response has no errors (missing, null or [])
#   CODE[,CODE]   one enum per error, from errors[].extensions.code
#   UNKNOWN       for an error with no code, or a code that is not a plain
#                 ^[A-Z_]{1,40}$ enum (never echoes free text)
# A non-array "errors" value counts as one UNKNOWN error.
#
# Note: "[.errors[]?.extensions.code // \"UNKNOWN\"]" is NOT equivalent: with no
# errors, "empty // x" yields x, so a clean response printed UNKNOWN.

def sanitize:
  if type == "string" and test("^[A-Z_]{1,40}$") then . else "UNKNOWN" end;

(if (.errors | type) == "array" then
   [.errors[] | (if type == "object" then (.extensions.code? // null) else null end) | sanitize]
 elif .errors == null then
   []
 else
   ["UNKNOWN"]
 end)
| if length == 0 then "none" else join(",") end
