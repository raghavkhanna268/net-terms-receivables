/**
 * Shared utilities for legal/public pages that render markdown as HTML.
 *
 * Used by /privacy and /terms routes - public resource routes with
 * no authentication, no session, and no shop data.
 */

/**
 * Simple markdown-to-HTML converter for Workers.
 *
 * Handles: headings, bold, links, code spans, code blocks, horizontal rules,
 * tables, lists (ordered and unordered), paragraphs.
 *
 * Key design choices:
 * - Code spans (`code`) are extracted FIRST and protected from emphasis processing
 * - Underscore emphasis (_text_) is only applied at word boundaries, not inside
 *   identifiers like snake_case or s8_tagged_customers
 * - Asterisk emphasis (*text*) requires whitespace boundaries, not attached to
 *   identifiers like email* or displayName*
 *
 * This is intentionally minimal to keep the Worker bundle small.
 * It does NOT add any dependencies.
 */
export function markdownToHtml(md: string): string {
  const lines = md.split("\n");
  const htmlLines: string[] = [];
  let inTable = false;
  let inList: "ul" | "ol" | null = null;
  let inCodeBlock = false;

  const escapeHtml = (text: string): string =>
    text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  const processInline = (text: string): string => {
    const codeSpans: string[] = [];

    let result = text.replace(/`([^`]+)`/g, (_match, code) => {
      const placeholder = `\x00CODE${codeSpans.length}\x00`;
      codeSpans.push(`<code>${escapeHtml(code)}</code>`);
      return placeholder;
    });

    result = escapeHtml(result);

    result = result.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    result = result.replace(/__(.+?)__/g, "<strong>$1</strong>");

    result = result.replace(/(?<=^|[\s(])\*(?!\s)([^*]+?)(?<!\s)\*(?=$|[\s,.):])/g, "<em>$1</em>");

    result = result.replace(/(?<=^|[\s(])_(?!\s)([^_]+?)(?<!\s)_(?=$|[\s,.):])/g, "<em>$1</em>");

    result = result.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
    );

    for (let i = 0; i < codeSpans.length; i++) {
      result = result.replace(`\x00CODE${i}\x00`, codeSpans[i]);
    }

    return result;
  };

  const closeList = () => {
    if (inList) {
      htmlLines.push(inList === "ul" ? "</ul>" : "</ol>");
      inList = null;
    }
  };

  const closeTable = () => {
    if (inTable) {
      htmlLines.push("</tbody></table>");
      inTable = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith("```")) {
      closeList();
      closeTable();
      if (inCodeBlock) {
        htmlLines.push("</code></pre>");
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        htmlLines.push("<pre><code>");
      }
      continue;
    }

    if (inCodeBlock) {
      htmlLines.push(escapeHtml(line));
      continue;
    }

    if (trimmed === "") {
      closeList();
      closeTable();
      continue;
    }

    if (/^-{3,}$/.test(trimmed) || /^\*{3,}$/.test(trimmed)) {
      closeList();
      closeTable();
      htmlLines.push("<hr>");
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      closeList();
      closeTable();
      const level = headingMatch[1].length;
      const headingText = processInline(headingMatch[2]);
      htmlLines.push(`<h${level}>${headingText}</h${level}>`);
      continue;
    }

    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      closeList();
      const cells = trimmed
        .slice(1, -1)
        .split("|")
        .map((c) => c.trim());

      if (cells.every((c) => /^[-:]+$/.test(c))) {
        continue;
      }

      if (!inTable) {
        inTable = true;
        htmlLines.push('<table class="privacy-table"><thead><tr>');
        for (const cell of cells) {
          htmlLines.push(`<th>${processInline(cell)}</th>`);
        }
        htmlLines.push("</tr></thead><tbody>");
      } else {
        htmlLines.push("<tr>");
        for (const cell of cells) {
          htmlLines.push(`<td>${processInline(cell)}</td>`);
        }
        htmlLines.push("</tr>");
      }
      continue;
    }

    const ulMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (ulMatch) {
      closeTable();
      if (inList !== "ul") {
        closeList();
        htmlLines.push("<ul>");
        inList = "ul";
      }
      htmlLines.push(`<li>${processInline(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = trimmed.match(/^\d+\.\s+(.+)$/);
    if (olMatch) {
      closeTable();
      if (inList !== "ol") {
        closeList();
        htmlLines.push("<ol>");
        inList = "ol";
      }
      htmlLines.push(`<li>${processInline(olMatch[1])}</li>`);
      continue;
    }

    closeList();
    closeTable();
    htmlLines.push(`<p>${processInline(trimmed)}</p>`);
  }

  closeList();
  closeTable();

  return htmlLines.join("\n");
}

export const LEGAL_PAGE_CSS = `
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
    line-height: 1.6;
    color: #1a1a1a;
    max-width: 800px;
    margin: 0 auto;
    padding: 2rem 1rem;
    background: #fff;
  }
  h1, h2, h3, h4 { margin-top: 2rem; margin-bottom: 1rem; color: #111; }
  h1 { font-size: 2rem; border-bottom: 2px solid #eee; padding-bottom: 0.5rem; }
  h2 { font-size: 1.5rem; border-bottom: 1px solid #eee; padding-bottom: 0.3rem; }
  h3 { font-size: 1.25rem; }
  p { margin: 1rem 0; }
  a { color: #0066cc; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code {
    background: #f4f4f4;
    padding: 0.2rem 0.4rem;
    border-radius: 3px;
    font-family: 'SF Mono', Consolas, monospace;
    font-size: 0.9em;
  }
  pre {
    background: #f4f4f4;
    padding: 1rem;
    border-radius: 5px;
    overflow-x: auto;
  }
  pre code { padding: 0; background: none; }
  ul, ol { margin: 1rem 0; padding-left: 2rem; }
  li { margin: 0.5rem 0; }
  hr { border: none; border-top: 1px solid #ddd; margin: 2rem 0; }
  .privacy-table {
    width: 100%;
    border-collapse: collapse;
    margin: 1rem 0;
    font-size: 0.95em;
  }
  .privacy-table th, .privacy-table td {
    border: 1px solid #ddd;
    padding: 0.75rem;
    text-align: left;
  }
  .privacy-table th { background: #f8f8f8; font-weight: 600; }
  .privacy-table tr:nth-child(even) { background: #fafafa; }
  strong { font-weight: 600; }
  @media (max-width: 600px) {
    body { padding: 1rem 0.5rem; }
    .privacy-table { font-size: 0.85em; }
    .privacy-table th, .privacy-table td { padding: 0.5rem; }
  }
`;

export const LEGAL_PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "public, max-age=3600",
};

export { markdownToHtml as _markdownToHtml };

export function renderLegalPage(
  markdownContent: string,
  title: string
): Response {
  const htmlContent = markdownToHtml(markdownContent);

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>${LEGAL_PAGE_CSS}</style>
</head>
<body>
${htmlContent}
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: LEGAL_PAGE_HEADERS,
  });
}
