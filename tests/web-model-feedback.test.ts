import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { digest } from "@/domain/primitives";
import type { WebAuditReceipt } from "@/domain/web-audits";
import { boundedWebAuditFeedback, webFeedbackPolicy } from "@/server/web/model-feedback";
import { webAuditFixture } from "./helpers/web-audit-fixture";

async function fixture() {
  const f = await webAuditFixture();
  function replace(path: string, data: unknown) {
    const reference = f.save(path, data), index = f.result.files.findIndex(item => item.path === path);
    f.result.files[index] = reference;
    const state = f.result.axe.find(item => item.file.path === path); if (state) state.file = reference;
    if (f.result.lighthouse?.file.path === path) f.result.lighthouse.file = reference;
  }
  function receipt(): WebAuditReceipt { return { id: randomUUID(), requestDigest: f.result.requestDigest, resultHash: digest(f.result), result: f.result }; }
  return { ...f, replace, receipt };
}
test("repair feedback carries original selectors, HTML, failure summary and immutable file references", async () => {
  const f = await fixture(), state = f.result.axe[0]!, original = JSON.parse(f.values.get(state.file.path)!.toString());
  original.violations = [{ id: "color-contrast", impact: "serious", help: "Ensure contrast", nodes: [{ target: ["#caption"], html: '<p id="caption">Original words</p>', failureSummary: "Contrast 2.1 is below 4.5." }] }];
  f.replace(state.file.path, original); state.violations = 1; state.seriousCritical = 1;
  const receipt = f.receipt(), before = digest(receipt), filesBefore = [...f.values].map(([key, bytes]) => [key, bytes.toString("base64")]);
  const result = boundedWebAuditFeedback(receipt, f.values), finding = result.excerpts.axe[0] as { firstNode: { selector: { text: string }; failureSummary: { text: string } } };
  assert.match(finding.firstNode.selector.text, /#caption/); assert.match(finding.firstNode.failureSummary.text, /2.1/);
  assert.equal(result.resultHash, receipt.resultHash); assert.equal(result.axe[0]!.originalFile.contentHash, state.file.contentHash);
  assert.equal(result.counts.axeFindings, 1); assert.equal(result.omitted.axeFindings, 0);
  assert.equal(digest(receipt), before); assert.deepEqual([...f.values].map(([key, bytes]) => [key, bytes.toString("base64")]), filesBefore);
});
test("Lighthouse repair feedback uses original accessibility audit references only", async () => {
  const f = await fixture(), path = f.result.lighthouse!.file.path, raw = JSON.parse(f.values.get(path)!.toString());
  raw.categories.accessibility.auditRefs = [{ id: "button-name" }, { id: "manual-check" }, { id: "pass" }];
  raw.audits = { "button-name": { score: 0, title: "Buttons need accessible names", description: "Name the existing button", details: { items: [{ node: { selector: "#play", snippet: "<button></button>" } }] } }, "manual-check": { score: null }, pass: { score: 1 }, "performance-only": { score: 0 } };
  f.replace(path, raw);
  const result = boundedWebAuditFeedback(f.receipt(), f.values);
  assert.equal(result.counts.lighthouseFailures, 1); assert.equal(result.excerpts.lighthouse.length, 1);
  assert.match(JSON.stringify(result.excerpts.lighthouse), /#play/); assert.doesNotMatch(JSON.stringify(result), /performance-only/);
});
test("large multilingual reports are bounded with explicit omissions and unchanged failure totals", async () => {
  const f = await fixture(), state = f.result.axe[0]!, original = JSON.parse(f.values.get(state.file.path)!.toString());
  original.violations = Array.from({ length: 40 }, (_, index) => ({ id: "finding-" + index, impact: "serious", help: "界".repeat(1000), nodes: [{ html: "界".repeat(10000), target: ["#original"], failureSummary: "Failure ".repeat(1000) }] }));
  original.incomplete = [{ id: "manual", nodes: [] }]; f.replace(state.file.path, original); state.violations = 40; state.seriousCritical = 40; state.incomplete = 1;
  for (const item of f.result.interactions) { item.passed = false; item.detail = "دليل".repeat(1000); item.observed = { html: "界".repeat(10000) }; }
  const receipt = f.receipt(), result = boundedWebAuditFeedback(receipt, f.values);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= webFeedbackPolicy.maximumCaseBytes);
  assert.equal(result.counts.axeFindings, 41); assert.equal(result.excerpts.axe.length + result.omitted.axeFindings, 41);
  assert.equal(result.counts.failedInteractions, 17); assert.equal(result.excerpts.interactions.length + result.omitted.failedInteractions, 17);
  assert.match(JSON.stringify(result), /omittedUtf8Bytes/); assert.equal(result.sourceDigest, receipt.result.sourceDigest);
});
test("altered original bytes cannot become model repair advice", async () => {
  const f = await fixture(); f.values.set(f.result.axe[0]!.file.path, Buffer.from('{"violations":[]}'));
  assert.throws(() => boundedWebAuditFeedback(f.receipt(), f.values), /original browser report/);
});
test("altered receipt binding is rejected before reading findings", async () => {
  const f = await fixture(), receipt = f.receipt(); receipt.result.sourceDigest = digest("another source");
  assert.throws(() => boundedWebAuditFeedback(receipt, f.values), /receipt changed/);
});
test("clean original reports do not acquire invented findings or a new acceptance claim", async () => {
  const f = await fixture(), result = boundedWebAuditFeedback(f.receipt(), f.values);
  assert.deepEqual(result.counts, { axeFindings: 0, lighthouseFailures: 0, failedInteractions: 0, errors: 0 });
  assert.equal(result.excerpts.axe.length, 0); assert.equal(result.excerpts.lighthouse.length, 0);
  assert.match(result.interpretation, /omission does not mean pass/); assert.equal("accepted" in result, false);
});
test("later critical findings take precedence over early manual-review items while every count remains visible", async () => {
  const f = await fixture(), early = f.result.axe[0]!, later = f.result.axe[1]!;
  const first = JSON.parse(f.values.get(early.file.path)!.toString()); first.incomplete = [{ id: "manual-one" }, { id: "manual-two" }];
  f.replace(early.file.path, first); early.incomplete = 2;
  const second = JSON.parse(f.values.get(later.file.path)!.toString()); second.violations = [{ id: "critical-later", impact: "critical", nodes: [{ target: ["#later"] }] }];
  f.replace(later.file.path, second); later.violations = 1; later.seriousCritical = 1;
  const result = boundedWebAuditFeedback(f.receipt(), f.values);
  assert.match(JSON.stringify(result.excerpts.axe[0]), /critical-later/); assert.equal(result.counts.axeFindings, 3); assert.equal(result.omitted.axeFindings, 1);
});
