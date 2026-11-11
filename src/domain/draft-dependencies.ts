import type { Commission, DraftDependencyProposal } from "@/contracts/guild";
import { planDigest } from "./fixture";
import { digest } from "./primitives";

export function draftDependencyProposal(commission: Commission): DraftDependencyProposal | null {
  const packages = commission.packages.filter(pkg => pkg.dependsOn.length && pkg.inputPolicy !== "reviewed_drafts").map(pkg => ({ id: pkg.id, title: pkg.title, fromVersion: pkg.contractVersion, toVersion: pkg.contractVersion + 1, grossMinor: pkg.grossMinor, dependsOn: pkg.dependsOn }));
  if (!packages.length || commission.mode !== "live") return null;
  const definition = { version: "guild.reviewed-draft-inputs.v1" as const, commissionId: commission.id, previousPlanDigest: planDigest(commission), packages, disclosure: "Draft production may use an exact upstream artifact only after its blocking deterministic checks pass and an explicitly automated review is recorded. The producing job binds those exact inputs. Human acceptance criteria, prices, source rights and payment gates remain unchanged. Final acceptance requires the exact upstream artifacts to receive curator acceptance; changed sources require a new downstream submission." };
  return { version: definition.version, digest: digest(definition), packages, disclosure: definition.disclosure };
}
