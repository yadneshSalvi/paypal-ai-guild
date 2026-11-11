import test from "node:test";
import assert from "node:assert/strict";
import { formatPlannerMessage, formatPlannerReadOnlyOptions, formatPlannerUserText } from "@/components/studio/planner-message-format";

test("native planner formatting displays actual Markdown headings, emphasis, lists and a semantic comparison table", () => {
  const text = "### Opening plan\n\n**Studio Ostrava** protects Friday.\n\n| Option | Award | Finish |\n| --- | ---: | :--- |\n| Studio Ostrava | $160 | Thursday 11am |\n| Slower offer | $130 | Monday |\n\n1. Read the saved plan\n2. Compare offers\n3. Save a proposal\n\n*Review* is still required.";
  const html = formatPlannerMessage(text);
  assert.match(html, /<h4>Opening plan<\/h4>/);
  assert.match(html, /<strong>Studio Ostrava<\/strong>/);
  assert.match(html, /<thead><tr><th scope="col">Option<\/th>/);
  assert.match(html, /<td>\$160<\/td><td>Thursday 11am<\/td>/);
  assert.match(html, /<ol><li>Read the saved plan<\/li>/);
  assert.match(html, /<em>Review<\/em>/);
  assert.equal(formatPlannerMessage(text), html);
  assert.ok(text.includes("**Studio Ostrava**"));
});

test("raw HTML, links, images and native mention tokens remain inert text", () => {
  const text = '<img src=x onerror="alert(1)"> **<script>alert(2)</script>**\n[open](javascript:alert(3)) ![tracking](https://example.test/pixel)\n{@:Museum:model:1" onclick="alert(4)} &lt;script&gt;';
  const html = formatPlannerMessage(text);
  assert.ok(!/<(?:img|script|iframe|a|svg|style)\b/i.test(html));
  assert.ok(!html.includes("{@:"));
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /<strong>&lt;script&gt;alert\(2\)&lt;\/script&gt;<\/strong>/);
  assert.match(html, /\[open\]\(javascript:alert\(3\)\)/);
  assert.match(html, /&amp;lt;script&amp;gt;/);
});

test("code, malformed tables and multilingual content retain their text without executing syntax", () => {
  const html = formatPlannerMessage("```html\n<img onerror='bad'> **literal**\n```\n\n`x < y`\n\nالعربية **المتحف** 日本語\n| incomplete | row |\n| -- | -- |\n[read](https://example.test/one_two_three)");
  assert.match(html, /<pre><code>&lt;img onerror=&#39;bad&#39;&gt; \*\*literal\*\*<\/code><\/pre>/);
  assert.match(html, /<code>x &lt; y<\/code>/);
  assert.match(html, /العربية <strong>المتحف<\/strong> 日本語/);
  assert.ok(!html.includes("<table>"));
  assert.ok(html.includes("https://example.test/one_two_three"));
});

test("large messages remain complete escaped text and restored user turns stay literal", () => {
  const long = "<keep>".repeat(12000), html = formatPlannerMessage(long);
  assert.equal((html.match(/&lt;keep&gt;/g) ?? []).length, 12000);
  const user = formatPlannerUserText("**my text**\n{@:x:y:z}\n<script>");
  assert.equal(user, "**my text**<br>&#123;@:x:y:z}<br>&lt;script&gt;");
  const options = formatPlannerReadOnlyOptions(["Protect Friday", '<img src="x">']);
  assert.match(options, /<li>Protect Friday<\/li>/);
  assert.match(options, /<li>&lt;img src=&quot;x&quot;&gt;<\/li>/);
  assert.ok(!options.includes("<button"));
});
