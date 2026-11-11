/** A display-only Markdown subset. Canonical conversation text is never changed.
 * No raw HTML, active links, images, custom attributes or Bryntum mention tokens
 * are emitted from untrusted assistant content. Unsupported syntax stays text.
 */
const escapeText = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/\{/g, "&#123;");

function inline(text: string): string {
  let html = "", cursor = 0;
  // Links remain inert, preserving the previous panel's navigation boundary.
  // Parse them as one literal before emphasis so underscores in URLs stay exact.
  const tokens = /!?\[[^\]\n]*\]\([^\n]*?\)|`[^`\n]+`|\*\*\*[^*\n]+\*\*\*|\*\*[^*\n]+\*\*|__[^_\n]+__|(?<![\p{L}\p{N}])\*[^*\n]+\*(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])_[^_\n]+_(?![\p{L}\p{N}])/gu;
  for (const match of text.matchAll(tokens)) {
    html += escapeText(text.slice(cursor, match.index));
    const value = match[0];
    if (/^!?\[/.test(value)) html += escapeText(value);
    else if (value.startsWith("`")) html += `<code>${escapeText(value.slice(1, -1))}</code>`;
    else if (value.startsWith("***")) html += `<strong><em>${escapeText(value.slice(3, -3))}</em></strong>`;
    else if (value.startsWith("**") || value.startsWith("__")) html += `<strong>${escapeText(value.slice(2, -2))}</strong>`;
    else html += `<em>${escapeText(value.slice(1, -1))}</em>`;
    cursor = match.index + value.length;
  }
  return html + escapeText(text.slice(cursor));
}

function cells(line: string): string[] | null {
  if (!line.includes("|") || line.includes("\\|") || line.includes("`")) return null;
  const text = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const columns = text.split("|").map(item => item.trim());
  return columns.length >= 2 && columns.length <= 8 ? columns : null;
}

export function formatPlannerMessage(text: string): string {
  if (!text) return "";
  if (text.length > 64 * 1024) return `<div class="guild-planner-prose">${escapeText(text).replace(/\r?\n/g, "<br>")}</div>`;
  const lines = text.replace(/\r\n?/g, "\n").split("\n"), html: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index]!;
    if (!line.trim()) { index++; continue; }
    if (/^\s*```/.test(line)) {
      const block: string[] = []; index++;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index]!)) block.push(lines[index++]!);
      if (index < lines.length) index++;
      html.push(`<pre><code>${escapeText(block.join("\n"))}</code></pre>`); continue;
    }
    const header = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (header) { html.push(`<h4>${inline(header[1]!)}</h4>`); index++; continue; }
    const columns = cells(line), separators = cells(lines[index + 1] ?? "");
    if (columns && separators?.length === columns.length && separators.every(cell => /^:?-{3,}:?$/.test(cell))) {
      const rows: string[][] = []; index += 2;
      while (index < lines.length) {
        const row = cells(lines[index]!); if (!row || row.length !== columns.length) break;
        rows.push(row); index++;
      }
      html.push(`<div class="guild-planner-table" role="region" aria-label="Planning comparison" tabindex="0"><table><thead><tr>${columns.map(cell => `<th scope="col">${inline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`); continue;
    }
    const list = /^\s{0,6}([-+*]|\d+[.)])\s+(.+)$/.exec(line);
    if (list) {
      const ordered = /^\d/.test(list[1]!), entries: string[] = [];
      const start = ordered ? Number.parseInt(list[1]!, 10) : 1;
      while (index < lines.length) {
        const entry = /^\s{0,6}([-+*]|\d+[.)])\s+(.+)$/.exec(lines[index]!);
        if (!entry || /^\d/.test(entry[1]!) !== ordered) break;
        entries.push(`<li>${inline(entry[2]!)}</li>`); index++;
      }
      const tag = ordered ? "ol" : "ul";
      html.push(`<${tag}${ordered && start > 1 && start <= 9999 ? ` start="${start}"` : ""}>${entries.join("")}</${tag}>`); continue;
    }
    const paragraph = [inline(line)]; index++;
    while (index < lines.length && lines[index]!.trim() && !/^\s{0,6}(?:#{1,6}\s|```|[-+*]\s|\d+[.)]\s)/.test(lines[index]!)
      && !(cells(lines[index]!) && cells(lines[index + 1] ?? "")?.every(cell => /^:?-{3,}:?$/.test(cell)))) paragraph.push(inline(lines[index++]!));
    html.push(`<p>${paragraph.join("<br>")}</p>`);
  }
  return `<div class="guild-planner-prose">${html.join("")}</div>`;
}

export const formatPlannerUserText = (text: string) => escapeText(text).replace(/\r?\n/g, "<br>");
export const formatPlannerReadOnlyOptions = (options: string[]) => `<div class="guild-planner-prose"><p>Saved choices · read-only</p><ul>${options.map(option => `<li>${escapeText(option)}</li>`).join("")}</ul></div>`;
