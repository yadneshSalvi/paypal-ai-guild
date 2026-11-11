/** Only text and the eight authored layout families cross the exhibition boundary. */
export function safeMediaUrl(value: string | null | undefined): string | null {
  if (!value || /[\u0000-\u001f\\]/.test(value)) return null;
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function safeExternalUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function safeImagePosition(value: string): string {
  if (/^(left|center|right)( (top|center|bottom))?$/.test(value)) return value;
  const pair = value.match(/^(\d{1,3})% (\d{1,3})%$/);
  return pair && Number(pair[1]) <= 100 && Number(pair[2]) <= 100 ? value : "50% 50%";
}

export function safeHexColor(value: string, fallback: string): string { return /^#[\da-fA-F]{6}$/.test(value) ? value : fallback; }
export function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c); }
export function safeScriptJson(value: unknown): string { return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029"); }
