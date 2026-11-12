export interface CaptionRuntimePageCacheAudit {
  version: "guild.caption-web-generated-route-cache-audit.v1";
  at: string;
  excludedPrefix: string;
  files: { path: string; bytes: number; sha256: string; mode: number }[];
  sha256: string;
  disclosure: string;
}
export interface CaptionCompositionFreezeVerification {
  version: "guild.caption-web-freeze-verification.v1";
  at: string;
  freezeSha256: string;
  buildId: string;
  verifiedFiles: number;
  verifiedLinks: number;
  privateFiles: number;
  generatedProofFiles: number;
  runtimePageCache: CaptionRuntimePageCacheAudit;
}
export function captionRuntimePageCacheAudit(root: string): CaptionRuntimePageCacheAudit;
export function verifyCaptionCompositionFreeze(root: string, freezeFile: string, fixtureFile?: string): CaptionCompositionFreezeVerification;
