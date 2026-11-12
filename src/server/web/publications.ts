import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import type { Commission } from "@/contracts/guild";
import { webArtifactSchema } from "@/domain/web-audits";
import { preparePublicationSchema, publicationFileDisclosure, publicationProposalSchema, publishExhibitionSchema, publicExhibitionPath, withdrawPublicationSchema,
  type PublicationEdition, type PublicationProposal, type PublicationWorkspace } from "@/domain/web-publication";
import { canonical, digest, DomainError } from "@/domain/primitives";
import { transaction } from "../db";
import type { Session } from "../session";
import type { PrivateBlobGateway } from "../media/blob-store";
import { bindAcceptedPublication } from "./publication-bindings";

export interface PublicationHead { tenant_id: string; commission_id: string; revision: number; last_version: number; current_edition_id: string | null; event_sequence: number; event_hash: string | null }
export interface PublicationRow { id: string; public_id: string; tenant_id: string; commission_id: string; version: number; revision: number; proposal_id: string; actor_id: string;
  proposal_digest: string; proposal: PublicationProposal; manifest_bytes: Buffer; signature: string; created_at: Date }
interface PublicationEventBody { action: "published" | "withdrawn"; editionId: string; version: number; proposalDigest: string; actorId: string; actorRole: "owner" | "judge"; reason: string; at: string; commandId: string }
interface PublicationEvent { id: string; tenant_id: string; commission_id: string; edition_id: string; sequence: number; revision: number; event_type: "published" | "withdrawn"; actor_id: string; command_id: string;
  body: PublicationEventBody; previous_hash: string | null; event_hash: string; created_at: Date }
type PublicationResult = { ok: true; kind: "prepared"; revision: number; proposal: PublicationProposal } | { ok: true; kind: "published"; revision: number; editionId: string; version: number; publicUrl: string }
  | { ok: true; kind: "withdrawn"; revision: number; editionId: string; version: number };
function fail(code: string, message: string, status = 409): never { throw new DomainError(code, message, status, status === 409 || status === 503); }
export const publicationSha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
function sign(kind: string, value: unknown) {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new DomainError("PUBLICATION_CONFIGURATION", "Publication signing is unavailable. Your private reading copy remains saved.", 503);
  return createHmac("sha256", secret).update(canonical({ kind: `guild.exhibition-publication-${kind}.v1`, value })).digest("hex");
}
function signatureMatches(actual: string, expected: string) { return /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected)); }
function proposalDigest(proposal: PublicationProposal) { const { digest: _digest, ...value } = proposal; return digest(value); }
function checkedProposal(raw: unknown, expectedDigest?: string): PublicationProposal {
  const parsed = publicationProposalSchema.safeParse(raw);
  if (!parsed.success || proposalDigest(parsed.data) !== parsed.data.digest || expectedDigest && parsed.data.digest !== expectedDigest) fail("PUBLICATION_LEDGER_CHANGED", "The exact publication proposal no longer matches its retained fingerprint.", 422);
  return parsed.data;
}
function editionIdentity(row: PublicationRow) { return { id: row.id, publicId: row.public_id, tenantId: row.tenant_id, commissionId: row.commission_id, version: row.version, revision: row.revision,
  proposalId: row.proposal_id, actorId: row.actor_id, proposalDigest: row.proposal_digest, manifestHash: publicationSha(row.manifest_bytes), publishedAt: row.created_at.toISOString() }; }
function eventIdentity(row: PublicationEvent) { return { id: row.id, tenantId: row.tenant_id, commissionId: row.commission_id, editionId: row.edition_id, sequence: row.sequence, revision: row.revision,
  action: row.event_type, actorId: row.actor_id, commandId: row.command_id, body: row.body, previousHash: row.previous_hash, at: row.created_at.toISOString() }; }

/** The database identity is checked at admission and just before commit. A
 * shared actor lock serializes revocation without renewing a production grant. */
async function activeActor(db: PoolClient, session: Session, mutation: boolean) {
  const row = (await db.query<{ role: Session["role"]; expires_at: Date; revoked_at: Date | null; tenant_expires_at: Date; observed_at: Date }>(
    "SELECT s.role,s.expires_at,s.revoked_at,t.expires_at AS tenant_expires_at,clock_timestamp() AS observed_at FROM guild_sessions s JOIN guild_tenants t ON t.id=s.tenant_id WHERE s.id=$1 AND s.tenant_id=$2 FOR SHARE OF s,t", [session.id, session.tenantId])).rows[0];
  if (!row || row.role !== session.role || row.revoked_at || row.expires_at <= row.observed_at || row.tenant_expires_at <= row.observed_at) fail("PUBLICATION_ACTOR_INACTIVE", "This workspace access has ended. Your accepted work and earlier editions remain in history.", 401);
  if (!(mutation ? ["owner", "judge"] : ["owner", "judge", "operator"]).includes(row.role)) fail("PUBLICATION_ROLE_REQUIRED", mutation ? "Only an active commission owner or judge can publish or withdraw an exhibition. Operator access is read-only." : "This publication history is available to its owner workspace.", 403);
  return { role: row.role as "owner" | "judge" | "operator", expiresAt: row.expires_at, now: row.observed_at };
}
async function commission(db: PoolClient, session: Session, exclusive: boolean) {
  const row = (await db.query<{ snapshot: Commission }>(`SELECT snapshot FROM guild_commissions WHERE tenant_id=$1 AND id=$2 FOR ${exclusive ? "UPDATE" : "SHARE"}`, [session.tenantId, sessionCommissionId(session)])).rows[0];
  if (!row || row.snapshot.tenantId !== session.tenantId || row.snapshot.id !== sessionCommissionId(session)) fail("COMMISSION_NOT_FOUND", "That commission is not in this workspace.", 404);
  return row.snapshot;
}
// Keep the route's commission identity explicit without adding authority to the
// existing Session type. This object is internal and never read from a cookie.
type CommissionSession = Session & { publicationCommissionId: string };
function sessionCommissionId(session: Session) { return (session as CommissionSession).publicationCommissionId; }
function scoped(session: Session, commissionId: string): CommissionSession { return { ...session, publicationCommissionId: z.string().uuid().parse(commissionId) }; }
async function lockedHead(db: PoolClient, tenantId: string, commissionId: string, create: boolean) {
  if (create) await db.query("INSERT INTO guild_web_publication_heads(tenant_id,commission_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [tenantId, commissionId]);
  return (await db.query<PublicationHead>(`SELECT tenant_id,commission_id,revision,last_version,current_edition_id,event_sequence,event_hash FROM guild_web_publication_heads WHERE tenant_id=$1 AND commission_id=$2 FOR ${create ? "UPDATE" : "SHARE"}`, [tenantId, commissionId])).rows[0]
    ?? { tenant_id: tenantId, commission_id: commissionId, revision: 0, last_version: 0, current_edition_id: null, event_sequence: 0, event_hash: null };
}
function expectRevision(head: PublicationHead, expected: number) { if (head.revision !== expected) fail("PUBLICATION_STALE", "Publication history changed while you were reviewing. Refresh it and prepare the current exact edition."); }

/** Used by the public reader only after locking this exact ledger head. No
 * active session or production capability is required to read a public edition. */
export async function publicationLedger(db: PoolClient, head: PublicationHead) {
  const editions = (await db.query<PublicationRow>("SELECT * FROM guild_web_publication_editions WHERE tenant_id=$1 AND commission_id=$2 ORDER BY version", [head.tenant_id, head.commission_id])).rows;
  const events = (await db.query<PublicationEvent>("SELECT * FROM guild_web_publication_events WHERE tenant_id=$1 AND commission_id=$2 ORDER BY sequence", [head.tenant_id, head.commission_id])).rows;
  for (const edition of editions) {
    const proposal = checkedProposal(edition.proposal, edition.proposal_digest);
    if (edition.proposal_id !== proposal.id || edition.tenant_id !== proposal.tenantId || edition.commission_id !== proposal.commissionId || edition.actor_id !== proposal.actorId || edition.version !== proposal.editionVersion
      || edition.revision !== proposal.expectedRevision + 1 || publicationSha(edition.manifest_bytes) !== proposal.binding.portable.manifestHash || !edition.manifest_bytes.equals(Buffer.from(canonical(proposal.binding.bundle)))
      || !signatureMatches(edition.signature, sign("edition", editionIdentity(edition)))) fail("PUBLICATION_LEDGER_CHANGED", "A retained publication edition changed its original proposal or manifest.", 422);
  }
  let previous: string | null = null;
  const published = new Set<string>(), withdrawn = new Set<string>();
  for (const [index, event] of events.entries()) {
    const edition = editions.find(item => item.id === event.edition_id), body = event.body;
    if (!edition || event.sequence !== index + 1 || event.previous_hash !== previous || !signatureMatches(event.event_hash, sign("event", eventIdentity(event)))
      || body.editionId !== edition.id || body.version !== edition.version || body.proposalDigest !== edition.proposal_digest || body.action !== event.event_type || body.actorId !== event.actor_id || body.commandId !== event.command_id
      || body.at !== event.created_at.toISOString() || !["owner", "judge"].includes(body.actorRole) || event.revision > head.revision
      || event.event_type === "published" && (published.has(edition.id) || event.revision !== edition.revision) || event.event_type === "withdrawn" && (!published.has(edition.id) || withdrawn.has(edition.id)))
      fail("PUBLICATION_LEDGER_CHANGED", "The publication and withdrawal history no longer matches its retained sequence.", 422);
    if (event.event_type === "published") published.add(edition.id); else withdrawn.add(edition.id);
    previous = event.event_hash;
  }
  if (head.event_sequence !== events.length || head.event_hash !== previous || editions.length !== head.last_version || editions.some((edition, index) => edition.version !== index + 1 || !published.has(edition.id))
    || head.current_edition_id && (!published.has(head.current_edition_id) || withdrawn.has(head.current_edition_id))) fail("PUBLICATION_LEDGER_CHANGED", "The publication head does not match its immutable edition history.", 422);
  return { editions, events, withdrawn, activeIds: editions.filter(item => !withdrawn.has(item.id)).map(item => item.id) };
}
async function commandReplay(db: PoolClient, session: CommissionSession, kind: string, commandId: string, input: unknown): Promise<PublicationResult | null> {
  const row = (await db.query<{ commission_id: string; actor_id: string; kind: string; payload_hash: string; result: PublicationResult }>("SELECT commission_id,actor_id,kind,payload_hash,result FROM guild_web_publication_commands WHERE tenant_id=$1 AND command_id=$2", [session.tenantId, commandId])).rows[0];
  if (!row) return null;
  if (row.commission_id !== session.publicationCommissionId || row.actor_id !== session.id || row.kind !== kind || row.payload_hash !== digest(input)) fail("PUBLICATION_COMMAND_CHANGED", "This decision identifier already belongs to a different exact publication request.");
  return row.result;
}
async function saveCommand(db: PoolClient, session: CommissionSession, kind: string, commandId: string, input: unknown, result: PublicationResult) {
  await db.query("INSERT INTO guild_web_publication_commands(tenant_id,command_id,commission_id,actor_id,kind,payload_hash,result) VALUES($1,$2,$3,$4,$5,$6,$7)", [session.tenantId, commandId, session.publicationCommissionId, session.id, kind, digest(input), result]);
  return result;
}
async function appendPublicationEvent(db: PoolClient, head: PublicationHead, edition: PublicationRow, actorId: string, actorRole: "owner" | "judge", commandId: string, action: "published" | "withdrawn", reason: string, at: string) {
  const body: PublicationEventBody = { action, editionId: edition.id, version: edition.version, proposalDigest: edition.proposal_digest, actorId, actorRole, reason, at, commandId };
  const event: PublicationEvent = { id: randomUUID(), tenant_id: head.tenant_id, commission_id: head.commission_id, edition_id: edition.id, sequence: head.event_sequence + 1, revision: head.revision,
    event_type: action, actor_id: actorId, command_id: commandId, body, previous_hash: head.event_hash, event_hash: "", created_at: new Date(at) };
  event.event_hash = sign("event", eventIdentity(event));
  await db.query("INSERT INTO guild_web_publication_events(id,tenant_id,commission_id,edition_id,sequence,revision,event_type,actor_id,command_id,body,previous_hash,event_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)", [event.id, event.tenant_id, event.commission_id, event.edition_id, event.sequence, event.revision, action, actorId, commandId, body, event.previous_hash, event.event_hash, at]);
  head.event_sequence = event.sequence; head.event_hash = event.event_hash;
}
async function saveHead(db: PoolClient, head: PublicationHead) {
  await db.query("UPDATE guild_web_publication_heads SET revision=$3,last_version=$4,current_edition_id=$5,event_sequence=$6,event_hash=$7,updated_at=clock_timestamp() WHERE tenant_id=$1 AND commission_id=$2", [head.tenant_id, head.commission_id, head.revision, head.last_version, head.current_edition_id, head.event_sequence, head.event_hash]);
}

export async function prepareExhibitionPublication(actor: Session, commissionId: string, raw: unknown, storage?: PrivateBlobGateway): Promise<PublicationResult> {
  const input = preparePublicationSchema.parse(raw), session = scoped(actor, commissionId);
  return transaction(async db => {
    await activeActor(db, session, true);
    const c = await commission(db, session, true), head = await lockedHead(db, session.tenantId, c.id, true);
    const replay = await commandReplay(db, session, "prepare", input.commandId, input); if (replay) return replay;
    expectRevision(head, input.expectedRevision);
    const ledger = await publicationLedger(db, head), binding = await bindAcceptedPublication(db, session, c, input.artifactId, input.selectedOrdinal, storage);
    const current = await activeActor(db, session, true), id = randomUUID(), preparedAt = current.now.toISOString(), expiresAt = new Date(Math.min(current.now.getTime() + 30 * 60_000, current.expiresAt.getTime())).toISOString();
    const values = { version: "guild.exhibition-publication-proposal.v1" as const, id, tenantId: session.tenantId, commissionId: c.id, actorId: session.id, actorRole: current.role as "owner" | "judge",
      expectedRevision: head.revision, editionVersion: head.last_version + 1, preparedAt, expiresAt, olderEditions: input.olderEditions, olderActiveIds: ledger.activeIds, editionNote: input.editionNote, fileDisclosure: publicationFileDisclosure, binding };
    const proposal = publicationProposalSchema.parse({ ...values, digest: digest(values) });
    await db.query("INSERT INTO guild_web_publication_proposals(id,tenant_id,commission_id,actor_id,command_id,expected_revision,proposal_digest,proposal,signature,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)", [id, session.tenantId, c.id, session.id, input.commandId, head.revision, proposal.digest, proposal, sign("proposal", proposal), preparedAt, expiresAt]);
    return saveCommand(db, session, "prepare", input.commandId, input, { ok: true, kind: "prepared", revision: head.revision, proposal });
  });
}
export async function publishExhibition(actor: Session, commissionId: string, raw: unknown, storage?: PrivateBlobGateway): Promise<PublicationResult> {
  const input = publishExhibitionSchema.parse(raw), session = scoped(actor, commissionId);
  return transaction(async db => {
    await activeActor(db, session, true);
    const c = await commission(db, session, true), head = await lockedHead(db, session.tenantId, c.id, true);
    const replay = await commandReplay(db, session, "publish", input.commandId, input); if (replay) return replay;
    expectRevision(head, input.expectedRevision);
    const saved = (await db.query<{ proposal: unknown; signature: string }>("SELECT proposal,signature FROM guild_web_publication_proposals WHERE id=$1 AND tenant_id=$2 AND commission_id=$3", [input.proposalId, session.tenantId, c.id])).rows[0];
    if (!saved) fail("PUBLICATION_PROPOSAL_REQUIRED", "Prepare this exact publication in your workspace before publishing.", 404);
    const proposal = checkedProposal(saved.proposal, input.proposalDigest);
    if (!signatureMatches(saved.signature, sign("proposal", proposal)) || proposal.actorId !== session.id || proposal.actorRole !== session.role || proposal.expectedRevision !== input.expectedRevision || proposal.editionVersion !== head.last_version + 1)
      fail("PUBLICATION_PROPOSAL_CHANGED", "This publication proposal belongs to a different actor or history revision. Prepare it again.");
    if (Date.parse(proposal.expiresAt) <= Date.now()) fail("PUBLICATION_PROPOSAL_EXPIRED", "This publication proposal has expired. Prepare the exact current files again.");
    const ledger = await publicationLedger(db, head);
    if (digest(ledger.activeIds) !== digest(proposal.olderActiveIds)) fail("PUBLICATION_STALE", "The earlier public editions changed. Review how they should be handled.");
    const binding = await bindAcceptedPublication(db, session, c, proposal.binding.artifactId, proposal.binding.selectedOrdinal, storage);
    if (digest(binding) !== digest(proposal.binding)) fail("PUBLICATION_BINDING_CHANGED", "The original source, acceptance, report or reader bytes changed after this proposal opened. Nothing was published.", 422);
    const current = await activeActor(db, session, true);
    if (current.now.getTime() >= Date.parse(proposal.expiresAt)) fail("PUBLICATION_PROPOSAL_EXPIRED", "This publication proposal expired while its files were being checked. Prepare it again.");
    head.revision++; head.last_version++;
    const edition: PublicationRow = { id: randomUUID(), public_id: randomBytes(24).toString("hex"), tenant_id: session.tenantId, commission_id: c.id, version: head.last_version, revision: head.revision,
      proposal_id: proposal.id, actor_id: session.id, proposal_digest: proposal.digest, proposal, manifest_bytes: Buffer.from(canonical(binding.bundle)), signature: "", created_at: current.now };
    edition.signature = sign("edition", editionIdentity(edition));
    await db.query("INSERT INTO guild_web_publication_editions(id,public_id,tenant_id,commission_id,version,revision,proposal_id,actor_id,proposal_digest,proposal,manifest_bytes,signature,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)", [edition.id, edition.public_id, edition.tenant_id, edition.commission_id, edition.version, edition.revision, edition.proposal_id, edition.actor_id, edition.proposal_digest, edition.proposal, edition.manifest_bytes, edition.signature, edition.created_at]);
    await appendPublicationEvent(db, head, edition, session.id, current.role as "owner" | "judge", input.commandId, "published", proposal.editionNote, current.now.toISOString());
    if (proposal.olderEditions === "withdraw") for (const earlier of ledger.editions.filter(item => ledger.activeIds.includes(item.id)))
      await appendPublicationEvent(db, head, earlier, session.id, current.role as "owner" | "judge", input.commandId, "withdrawn", `Replaced by edition ${edition.version}. Earlier links withdrawn by the curator's explicit publication choice.`, current.now.toISOString());
    head.current_edition_id = edition.id; await saveHead(db, head);
    return saveCommand(db, session, "publish", input.commandId, input, { ok: true, kind: "published", revision: head.revision, editionId: edition.id, version: edition.version, publicUrl: publicExhibitionPath(edition.public_id) });
  });
}
export async function withdrawExhibition(actor: Session, commissionId: string, raw: unknown): Promise<PublicationResult> {
  const input = withdrawPublicationSchema.parse(raw), session = scoped(actor, commissionId);
  return transaction(async db => {
    await activeActor(db, session, true); const c = await commission(db, session, true), head = await lockedHead(db, session.tenantId, c.id, true);
    const replay = await commandReplay(db, session, "withdraw", input.commandId, input); if (replay) return replay;
    expectRevision(head, input.expectedRevision);
    const ledger = await publicationLedger(db, head), edition = ledger.editions.find(item => item.id === input.editionId);
    if (!edition) fail("PUBLICATION_NOT_FOUND", "That exact edition is not in this commission.", 404);
    if (ledger.withdrawn.has(edition.id)) fail("PUBLICATION_ALREADY_WITHDRAWN", "This edition was already withdrawn. Republishing creates a new edition and link.");
    const current = await activeActor(db, session, true); head.revision++;
    await appendPublicationEvent(db, head, edition, session.id, current.role as "owner" | "judge", input.commandId, "withdrawn", input.reason, current.now.toISOString());
    if (head.current_edition_id === edition.id) head.current_edition_id = null;
    await saveHead(db, head);
    return saveCommand(db, session, "withdraw", input.commandId, input, { ok: true, kind: "withdrawn", revision: head.revision, editionId: edition.id, version: edition.version });
  });
}

export async function publicationWorkspace(actor: Session, commissionId: string): Promise<PublicationWorkspace> {
  const session = scoped(actor, commissionId);
  return transaction(async db => {
    const active = await activeActor(db, session, false), c = await commission(db, session, false), head = await lockedHead(db, session.tenantId, c.id, false), ledger = await publicationLedger(db, head);
    const decisions = (await db.query<{ artifact_id: string; artifact_hash: string; contract_version: number; role: string; review_disclosures: Record<string, unknown> }>("SELECT a.artifact_id,a.artifact_hash,a.contract_version,s.role,a.review_disclosures FROM guild_acceptance_decisions a JOIN guild_sessions s ON s.id=a.actor_id AND s.tenant_id=a.tenant_id WHERE a.tenant_id=$1 AND a.commission_id=$2 AND a.decision='accepted'", [session.tenantId, c.id])).rows;
    const accepted = (artifactId: string, artifactHash: string) => decisions.some(item => item.artifact_id === artifactId && item.artifact_hash === artifactHash && ["owner", "judge"].includes(item.role) && item.review_disclosures.humanReviewed === true);
    const candidates: PublicationWorkspace["candidates"] = [];
    for (const artifact of c.artifacts) {
      const parsed = webArtifactSchema.safeParse(artifact.content); if (!parsed.success) continue;
      const identities = [{ artifactId: artifact.id, artifactHash: artifact.contentHash }, ...parsed.data.sources.ancestors];
      const acceptedCount = identities.filter(item => accepted(item.artifactId, item.artifactHash)).length;
      candidates.push({ artifactId: artifact.id, title: artifact.title, selectedOrdinal: parsed.data.selectedOrdinal, artifactHash: artifact.contentHash, createdAt: artifact.createdAt,
        accepted: accepted(artifact.id, artifact.contentHash) && acceptedCount === 6, acceptedCount, requiredCount: 6, disclosure: artifact.provenance.label });
    }
    const downloads = (await db.query<{ edition_id: string; count: string }>("SELECT d.edition_id,count(*) AS count FROM guild_web_publication_downloads d JOIN guild_web_publication_editions e ON e.id=d.edition_id AND e.tenant_id=d.tenant_id WHERE e.tenant_id=$1 AND e.commission_id=$2 AND d.path='exhibition.zip' GROUP BY d.edition_id", [session.tenantId, c.id])).rows;
    const editions: PublicationEdition[] = ledger.editions.map(edition => {
      const withdrawal = ledger.events.find(event => event.edition_id === edition.id && event.event_type === "withdrawn");
      return { id: edition.id, publicId: edition.public_id, version: edition.version, revision: edition.revision, publishedAt: edition.created_at.toISOString(), actorRole: edition.proposal.actorRole,
        publicUrl: publicExhibitionPath(edition.public_id), downloadUrl: publicExhibitionPath(edition.public_id, "exhibition.zip"), manifestUrl: publicExhibitionPath(edition.public_id, "bundle-manifest.json"),
        proposalDigest: edition.proposal_digest, editionNote: edition.proposal.editionNote, state: withdrawal ? "withdrawn" : head.current_edition_id === edition.id ? "current" : "earlier",
        withdrawnAt: withdrawal?.created_at.toISOString() ?? null, withdrawalReason: withdrawal?.body.reason ?? null, withdrawnByRole: withdrawal?.body.actorRole ?? null,
        binding: edition.proposal.binding, downloadResponses: Number(downloads.find(item => item.edition_id === edition.id)?.count ?? 0) };
    });
    const synthetic = decisions.find(item => item.review_disclosures.syntheticFixture === true && typeof item.review_disclosures.disclosure === "string");
    return { commissionId: c.id, title: c.title, museum: c.museum, revision: head.revision, currentEditionId: head.current_edition_id, canPublish: active.role !== "operator", actorRole: active.role,
      fixtureDisclosure: synthetic ? String(synthetic.review_disclosures.disclosure) : null,
      candidates: candidates.reverse(), editions: editions.reverse(), history: ledger.events.map(event => ({ id: event.id, sequence: event.sequence, revision: event.revision, editionId: event.edition_id,
        version: event.body.version, action: event.event_type, at: event.created_at.toISOString(), actorRole: event.body.actorRole, reason: event.body.reason, proposalDigest: event.body.proposalDigest })).reverse() };
  });
}

export async function lockPublicEdition(db: PoolClient, publicId: string) {
  if (!/^[a-f0-9]{48}$/.test(publicId)) fail("PUBLICATION_NOT_FOUND", "This exhibition link is unavailable.", 404);
  const identity = (await db.query<{ tenant_id: string; commission_id: string }>("SELECT tenant_id,commission_id FROM guild_web_publication_editions WHERE public_id=$1", [publicId])).rows[0];
  if (!identity) fail("PUBLICATION_NOT_FOUND", "This exhibition link is unavailable.", 404);
  const head = await lockedHead(db, identity.tenant_id, identity.commission_id, false), ledger = await publicationLedger(db, head), edition = ledger.editions.find(item => item.public_id === publicId);
  if (!edition) fail("PUBLICATION_NOT_FOUND", "This exhibition link is unavailable.", 404);
  if (ledger.withdrawn.has(edition.id)) fail("PUBLICATION_WITHDRAWN", "The curator withdrew this exhibition. Previously downloaded copies cannot be recalled.", 410);
  return edition;
}

/** An owner-scoped receipt with the exact records named by the edition. A newer
 * verification or acceptance is never substituted into this historical export. */
export async function publicationEditionReceipt(actor: Session, commissionId: string, editionId: string) {
  z.string().uuid().parse(editionId); const session = scoped(actor, commissionId);
  return transaction(async db => {
    await activeActor(db, session, false); const c = await commission(db, session, false), head = await lockedHead(db, session.tenantId, c.id, false), ledger = await publicationLedger(db, head);
    const edition = ledger.editions.find(item => item.id === editionId);
    if (!edition) fail("PUBLICATION_NOT_FOUND", "That exact edition is not in this commission.", 404);
    const accepted = [];
    const hashRecord = (value: unknown) => digest(JSON.parse(JSON.stringify(value)));
    for (const source of edition.proposal.binding.accepted) {
      const decision = (await db.query("SELECT id,package_id,contract_version,artifact_id,artifact_hash,criteria_digest,actor_id,decision,review_disclosures,created_at FROM guild_acceptance_decisions WHERE id=$1 AND tenant_id=$2 AND commission_id=$3", [source.decision.id, c.tenantId, c.id])).rows[0];
      const verification = (await db.query("SELECT id,criteria_digest,result,created_at FROM guild_verifications WHERE id=$1 AND tenant_id=$2 AND commission_id=$3", [source.verification.id, c.tenantId, c.id])).rows[0];
      const independent = source.verification.jobId ? (await db.query("SELECT id,output FROM guild_jobs WHERE id=$1 AND tenant_id=$2 AND commission_id=$3", [source.verification.jobId, c.tenantId, c.id])).rows[0] : null;
      if (!decision || !verification || hashRecord(decision) !== source.decision.recordHash || hashRecord(verification) !== source.verification.recordHash || source.verification.jobId && (!independent || digest(independent.output) !== source.verification.outputHash))
        fail("PUBLICATION_EVIDENCE_CHANGED", "An original acceptance or report no longer matches this edition. Its saved fingerprints remain in publication history; no later record was substituted.", 422);
      accepted.push({ kind: source.kind, artifactId: source.artifactId, artifactHash: source.artifactHash, decision, verification, independent });
    }
    return { schemaVersion: "guild.exhibition-publication-receipt.v1", edition: editionIdentity(edition), proposal: edition.proposal, signature: edition.signature,
      publicLink: publicExhibitionPath(edition.public_id), events: ledger.events.filter(event => event.edition_id === edition.id).map(event => ({ ...eventIdentity(event), eventHash: event.event_hash })), accepted,
      disclosure: "Exact retained publication, original acceptance disclosures and verification identities. Server-signed application records are not independent notarization or fluent-language review. A withdrawal closes the public link without rewriting this receipt." };
  });
}
