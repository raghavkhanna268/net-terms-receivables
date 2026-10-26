#!/usr/bin/env python3
"""Read-only guard for committed bulk query files (prod-bulk-count.yml).

Usage: guard_query.py <query-file> <expected-top-level-field>

Exit 0 when the file is exactly the fixed bulkOperationRunQuery wrapper
around a read query whose only top-level field is <expected-top-level-field>.
Otherwise exit 3 and write one fixed reason code to stderr (never file text).
The workflow maps a non-zero exit to: bulk_count=refused code=QUERY_NOT_READONLY

Checks:
  1. Exactly one triple-quoted block (the inner bulk query).
  2. Outside that block the document is exactly the fixed wrapper:
       <op keyword> <Name> { bulkOperationRunQuery(query: <block>)
         { bulkOperation { id status url } userErrors { field message } } }
     (whitespace-insensitive). No other operation or field is allowed.
  3. The inner query contains no operation/fragment keyword other than query,
     no comments, no aliases, no top-level fragment spreads, and its
     top-level field set is exactly [<expected-top-level-field>].
Shopify's bulkOperationRunQuery also only accepts query documents.
"""

import re
import sys

# The only write-capable document shape this repo may submit (see the
# workflow-readonly test, which pins every line of this file that names it).
WRAPPER_RE = re.compile(
    r"\Amutation [A-Za-z_][A-Za-z0-9_]*\{bulkOperationRunQuery\(query:@Q@\)"
    r"\{bulkOperation\{id status url\}userErrors\{field message\}\}\}\Z"
)
FORBIDDEN_INNER_RE = re.compile(r"\b(mutation|subscription|fragment)\b", re.IGNORECASE)


def fail(code):
    sys.stderr.write("guard_reason=%s\n" % code)
    sys.exit(3)


def normalize(s):
    s = re.sub(r"\s+", " ", s).strip()
    return re.sub(r"\s*([(){}:,])\s*", r"\1", s)


def top_level_fields(inner):
    # Drop string literals (arguments such as the search string).
    body = re.sub(r'"(?:[^"\\]|\\.)*"', '""', inner)
    if '"' in body.replace('""', ""):
        fail("INNER_UNBALANCED_STRING")
    body = normalize(body)
    m = re.match(r"\A(?:query(?: [A-Za-z_][A-Za-z0-9_]*)?)?\{(.*)\}\Z", body)
    if not m:
        fail("INNER_NOT_QUERY_SELECTION")
    sel = m.group(1)
    fields, depth, paren, token = [], 0, 0, ""
    for ch in sel + " ":
        if paren:
            if ch == "(":
                paren += 1
            elif ch == ")":
                paren -= 1
            continue
        if ch == "(":
            paren = 1
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth < 0:
                fail("INNER_UNBALANCED_BRACES")
        elif depth == 0 and ch == ":":
            fail("INNER_ALIAS")
        elif depth == 0 and ch == ".":
            fail("INNER_TOP_LEVEL_SPREAD")
        if depth == 0 and (ch.isalnum() or ch == "_"):
            token += ch
            continue
        if token:
            fields.append(token)
            token = ""
    if depth != 0 or paren != 0:
        fail("INNER_UNBALANCED_BRACES")
    return fields


def main():
    if len(sys.argv) != 3:
        fail("USAGE")
    path, expected = sys.argv[1], sys.argv[2]
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", expected):
        fail("BAD_EXPECTED_FIELD")
    try:
        with open(path, "r", encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        fail("FILE_UNREADABLE")

    parts = text.split('"""')
    if len(parts) != 3:
        fail("BLOCK_COUNT")
    outer = parts[0] + "@Q@" + parts[2]
    inner = parts[1]

    if "#" in outer or "#" in inner:
        fail("COMMENT_PRESENT")
    if not WRAPPER_RE.match(normalize(outer)):
        fail("WRAPPER_MISMATCH")
    if FORBIDDEN_INNER_RE.search(inner):
        fail("INNER_KEYWORD")
    if top_level_fields(inner) != [expected]:
        fail("INNER_TOP_LEVEL_FIELD")
    sys.exit(0)


if __name__ == "__main__":
    main()
