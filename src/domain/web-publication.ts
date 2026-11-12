import { z } from "zod";
import { webBundleSchema } from "./web-exhibition";
import { acceptedWebCaptionProvenanceSchema } from "./web-caption-provenance";

const uuid = z.string().uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/), revision = z.number().int().nonnegative();
export const publicationKinds = ["research", "translation", "narration", "images", "captions", "web"] as const;
export const publicationFileDisclosure = "Every file in this exact reading copy will be public, including all six languages, photographs, recordings, captions, source text, design choices, source identifiers and font licences. Previously downloaded copies cannot be recalled.";
export const publicationAcceptanceSchema = z.object({
  kind: z.enum(publicationKinds), packageId: z.string().min(1), contractVersion: z.number().int().positive(),
  artifactId: uuid, artifactHash: hash, artifactManifestHash: hash, title: z.string(),
  decision: z.object({ id: uuid, actorId: uuid, actorRole: z.enum(["owner", "judge"]), acceptedAt: z.string().datetime(), recordHash: hash,
    criteriaDigest: hash, humanReviewed: z.literal(true), fluentReviewed: z.literal(false), disclosure: z.string().min(1), disclosures: z.record(z.string(), z.unknown()) }).strict(),
  verification: z.object({ id: uuid, recordHash: hash, resultHash: hash, criteriaDigest: hash, createdAt: z.string().datetime(), jobId: uuid.nullable(), outputHash: hash.nullable() }).strict(),
  production: z.object({ jobId: uuid, jobHash: hash, snapshotHash: hash, approvalReceiptHash: hash }).strict(),
}).strict();
export type PublicationAcceptance = z.infer<typeof publicationAcceptanceSchema>;
export const publicationBindingSchema = z.object({
  version: z.literal("guild.exhibition-publication-binding.v1"), artifactId: uuid, artifactHash: hash, artifactManifestHash: hash,
  sourceDigest: hash, sourceReviewsHash: hash, selectedOrdinal: z.number().int().min(1).max(3), designDigest: hash, bundleId: uuid,
  bundleManifestHash: hash, bundleFilesDigest: hash, sourceRecordHash: hash, rendererDigest: hash, bundle: webBundleSchema,
  portable: z.object({ manifestPath: z.literal("bundle-manifest.json"), manifestHash: hash, manifestByteLength: z.number().int().positive(),
    zipPath: z.literal("exhibition.zip"), zipHash: hash, zipByteLength: z.number().int().positive() }).strict(),
  accepted: z.array(publicationAcceptanceSchema).length(6),
  captionReview: acceptedWebCaptionProvenanceSchema.optional(),
  independent: z.object({ jobId: uuid, outputHash: hash, reportHash: hash, filesHash: hash,
    cases: z.array(z.object({ id: uuid, requestHash: hash, resultHash: hash, filesHash: hash }).strict()).length(18) }).strict(),
  disclosures: z.array(z.string().min(1)).min(1),
}).strict();
export type PublicationBinding = z.infer<typeof publicationBindingSchema>;
export const publicationProposalSchema = z.object({
  version: z.literal("guild.exhibition-publication-proposal.v1"), id: uuid, tenantId: uuid, commissionId: uuid,
  actorId: uuid, actorRole: z.enum(["owner", "judge"]), expectedRevision: revision, editionVersion: z.number().int().positive(),
  preparedAt: z.string().datetime(), expiresAt: z.string().datetime(), olderEditions: z.enum(["keep", "withdraw"]),
  olderActiveIds: z.array(uuid), editionNote: z.string().max(1000), fileDisclosure: z.literal(publicationFileDisclosure),
  binding: publicationBindingSchema, digest: hash,
}).strict();
export type PublicationProposal = z.infer<typeof publicationProposalSchema>;
export const preparePublicationSchema = z.object({ commandId: uuid, expectedRevision: revision, artifactId: uuid,
  selectedOrdinal: z.number().int().min(1).max(3), olderEditions: z.enum(["keep", "withdraw"]), editionNote: z.string().trim().max(1000).default("") }).strict();
export const publishExhibitionSchema = z.object({ commandId: uuid, proposalId: uuid, proposalDigest: hash,
  expectedRevision: revision, acknowledgePublicFiles: z.literal(true) }).strict();
export const withdrawPublicationSchema = z.object({ commandId: uuid, editionId: uuid, expectedRevision: revision,
  reason: z.string().trim().min(8).max(1000), acknowledgeCopiesRemain: z.literal(true) }).strict();
export type PreparePublication = z.infer<typeof preparePublicationSchema>;
export type PublishExhibition = z.infer<typeof publishExhibitionSchema>;
export type WithdrawPublication = z.infer<typeof withdrawPublicationSchema>;
export interface PublicationEdition {
  id: string; publicId: string; version: number; revision: number; publishedAt: string; actorRole: "owner" | "judge";
  publicUrl: string; downloadUrl: string; manifestUrl: string; proposalDigest: string; editionNote: string;
  state: "current" | "earlier" | "withdrawn"; withdrawnAt: string | null; withdrawalReason: string | null;
  withdrawnByRole: "owner" | "judge" | null; binding: PublicationBinding; downloadResponses: number;
}
export interface PublicationWorkspace {
  commissionId: string; title: string; museum: string; revision: number; currentEditionId: string | null;
  canPublish: boolean; actorRole: "owner" | "judge" | "operator";
  fixtureDisclosure: string | null;
  candidates: { artifactId: string; title: string; selectedOrdinal: number; artifactHash: string; createdAt: string;
    accepted: boolean; acceptedCount: number; requiredCount: 6; disclosure: string }[];
  editions: PublicationEdition[];
  history: { id: string; sequence: number; revision: number; editionId: string; version: number; action: "published" | "withdrawn";
    at: string; actorRole: "owner" | "judge"; reason: string; proposalDigest: string }[];
}
export const publicExhibitionPath = (publicId: string, path = "index.html") => `/published/${publicId}/${path}`;
