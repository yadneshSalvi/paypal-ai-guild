import type { WebAuditReceipt } from "@/domain/web-audits";
import { digest, DomainError } from "@/domain/primitives";
import { readWebEvidenceJson } from "./audit-evidence";

export const webFeedbackPolicy = Object.freeze({ version: "guild.native-audit-feedback.v1", maximumCaseBytes: 6144, maximumAxeFindings: 2, maximumLighthouseFindings: 2, maximumInteractionFindings: 3, maximumTextBytes: 240 });
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
/** Byte-bounded, visibly abbreviated untrusted text. Never rewrite the original report. */
function excerpt(value: unknown) {
  const original = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
  let text = "", used = 0;
  for (const char of original) { const size = Buffer.byteLength(char); if (used + size > webFeedbackPolicy.maximumTextBytes) break; text += char; used += size; }
  return { text, omittedUtf8Bytes: Buffer.byteLength(original) - used };
}
/** Only exact saved receipts and their original hash-checked files are accepted.
 * Callers additionally verify the durable signature/owner through audit-store.
 * This projection is repair advice, never an independent acceptance result. */
export function boundedWebAuditFeedback(receipt: WebAuditReceipt, files: Map<string, Buffer>) {
  if (receipt.resultHash !== digest(receipt.result) || receipt.requestDigest !== receipt.result.requestDigest)
    throw new DomainError("WEB_MODEL_FEEDBACK", "The original browser receipt changed before feedback extraction.", 422, false);
  const result = receipt.result;
  const selectedAxe: Array<{ state: string; kind: string; path: string; value: unknown; priority: number }> = [], lighthouseFindings: unknown[] = [];
  const axe = result.axe.map(state => {
    const raw = readWebEvidenceJson(state.file, result.files, files);
    const findings = [ ...array(raw.violations).map(value => ({ kind: "violation", value })), ...array(raw.incomplete).map(value => ({ kind: "incomplete", value })) ];
    for (const finding of findings) {
      const severity = ["critical", "serious", "moderate", "minor"].indexOf(String(record(finding.value).impact));
      selectedAxe.push({ state: state.state, kind: finding.kind, path: state.file.path, value: finding.value, priority: finding.kind === "incomplete" ? 5 : severity < 0 ? 4 : severity });
      selectedAxe.sort((left, right) => left.priority - right.priority);
      if (selectedAxe.length > webFeedbackPolicy.maximumAxeFindings) selectedAxe.pop();
    }
    return { state: state.state, originalFile: state.file, violations: state.violations, seriousCritical: state.seriousCritical, incomplete: state.incomplete };
  });
  const axeFindings: unknown[] = selectedAxe.map(finding => {
    const item = record(finding.value), nodes = array(item.nodes), node = record(nodes[0]);
    return { state: finding.state, kind: finding.kind, originalFile: finding.path, id: excerpt(item.id), impact: excerpt(item.impact), help: excerpt(item.help),
      nodeCount: nodes.length, firstNode: nodes.length ? { selector: excerpt(node.target), html: excerpt(node.html), failureSummary: excerpt(node.failureSummary) } : null };
  });
  let lighthouseFailedCount = 0;
  if (result.lighthouse) {
    const raw = readWebEvidenceJson(result.lighthouse.file, result.files, files), audits = record(raw.audits);
    // Accessibility references only: performance or unrelated score failures must
    // not be misrepresented as the agreed exhibition accessibility criterion.
    const refs = array(record(record(raw.categories).accessibility).auditRefs);
    for (const reference of refs) {
      const id = record(reference).id; if (typeof id !== "string") continue;
      const audit = record(audits[id]);
      if (typeof audit.score !== "number" || audit.score >= 1) continue;
      lighthouseFailedCount++;
      if (lighthouseFindings.length >= webFeedbackPolicy.maximumLighthouseFindings) continue;
      const details = record(audit.details), items = array(details.items), first = record(items[0]);
      lighthouseFindings.push({ id: excerpt(id), title: excerpt(audit.title), score: audit.score, description: excerpt(audit.description), itemCount: items.length,
        firstNode: items.length ? excerpt(first.node ?? first) : null });
    }
  }
  const failedInteractions = result.interactions.filter(item => !item.passed), totalAxe = axe.reduce((sum, state) => sum + state.violations + state.incomplete, 0);
  const feedback = {
    policy: webFeedbackPolicy.version, caseId: receipt.id, caseKey: result.caseId, requestDigest: receipt.requestDigest, resultHash: receipt.resultHash,
    sourceDigest: result.sourceDigest, designDigest: result.designDigest, bundleDigest: result.bundleDigest, locale: result.locale, viewport: result.viewport,
    complete: result.complete, axe, lighthouse: result.lighthouse,
    counts: { axeFindings: totalAxe, lighthouseFailures: lighthouseFailedCount, failedInteractions: failedInteractions.length, errors: result.errors.length },
    excerpts: { axe: axeFindings, lighthouse: lighthouseFindings, interactions: failedInteractions.slice(0, webFeedbackPolicy.maximumInteractionFindings).map(item => ({ id: item.id, detail: excerpt(item.detail), observed: excerpt(item.observed) })),
      errors: result.errors.slice(0, 2).map(item => ({ code: item.code, message: excerpt(item.message) })) },
    omitted: { axeFindings: totalAxe - axeFindings.length, lighthouseFailures: lighthouseFailedCount - lighthouseFindings.length, failedInteractions: Math.max(0, failedInteractions.length - webFeedbackPolicy.maximumInteractionFindings), errors: Math.max(0, result.errors.length - 2), caseByteLimitReached: false },
    interpretation: "Untrusted bounded excerpts of retained original reports. Complete original files remain available. Incomplete findings require review; excerpt omission does not mean pass.",
  };
  // Preserve every case, its original references, counts and binding hashes.
  // Deterministically omit only excerpts when unusually verbose originals would
  // exceed the published per-case model budget; disclose each omitted item.
  while (Buffer.byteLength(JSON.stringify(feedback)) > webFeedbackPolicy.maximumCaseBytes) {
    feedback.omitted.caseByteLimitReached = true;
    if (feedback.excerpts.errors.length) { feedback.excerpts.errors.pop(); feedback.omitted.errors++; }
    else if (feedback.excerpts.interactions.length) { feedback.excerpts.interactions.pop(); feedback.omitted.failedInteractions++; }
    else if (feedback.excerpts.lighthouse.length) { feedback.excerpts.lighthouse.pop(); feedback.omitted.lighthouseFailures++; }
    else if (feedback.excerpts.axe.length) { feedback.excerpts.axe.pop(); feedback.omitted.axeFindings++; }
    else throw new DomainError("WEB_MODEL_FEEDBACK_CAPACITY", "The original audit references exceed the declared model feedback capacity. Original reports remain retained.", 422, false);
  }
  return feedback;
}
