import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { CONTROLLED_PROVIDER_IDS, PROVIDER_SETUP_VERSION, accessOriginSchema, controlledProviderSetupPlanSchema,
  type ControlledProviderSetupPlan } from "@/contracts/provider-access";
import { providerDefinitions } from "@/domain/fixture";
import { digest, DomainError } from "@/domain/primitives";
import { transaction } from "../db";
import { marketOrigin, providerRow, type MarketDb } from "../provider-market/registry";
import { providerBindingDigest, secretHash } from "./identity";
import { browserEntryOrigins } from "./origin";

export interface ProviderSetupReceipt {
  version: typeof PROVIDER_SETUP_VERSION; operationId: string; digest: string; appliedAt: string;
  providersCreated: number; providersPreserved: number;
  invitations: { id: string; providerId: string; ownerIdentity: string; bindingDigest: string; expiresAt: string; sessionCeilingAt: string }[];
}
export interface ProviderInvitationDelivery { invitationId: string; providerId: string; challenge: string; url: string }
interface RegistryRecord { id: string; owner_identity: string; endpoint: string; card_url: string; kinds: string[];
  provenance: string; synthetic_fixture: boolean; revoked_at: string | null; profile: { displayName: string }; [key: string]: unknown }

/** Catalog and database identity are read-only. No initializer or provider
 * discovery is reachable from setup inspection. */
export async function providerSetupState(db: MarketDb): Promise<{
  databaseIdentity: ControlledProviderSetupPlan["databaseIdentity"]; schemaFingerprint: string;
  registryFingerprint: string; registry: RegistryRecord[];
}> {
  const identity = (await db.query<{ database: string; schema: string; server: unknown }>(
    "SELECT current_database() AS database,current_schema() AS schema,jsonb_build_object('version',current_setting('server_version_num'),'port',current_setting('port'),'started',pg_postmaster_start_time(),'role',current_user,'login',session_user) AS server")).rows[0]!;
  if (!identity.schema || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(identity.schema)) throw new DomainError("SETUP_SCHEMA", "Use one explicit existing reviewed schema.", 409, false);
  const catalog = await db.query<{ value: unknown }>(`SELECT jsonb_build_object(
    'columns',(SELECT jsonb_agg(to_jsonb(c) ORDER BY c.table_name,c.ordinal_position) FROM information_schema.columns c WHERE c.table_schema=current_schema()),
    'constraints',(SELECT jsonb_agg(jsonb_build_object('table',r.relname,'name',c.conname,'definition',pg_get_constraintdef(c.oid)) ORDER BY r.relname,c.conname) FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname=current_schema()),
    'indexes',(SELECT jsonb_agg(to_jsonb(i) ORDER BY i.tablename,i.indexname) FROM pg_indexes i WHERE i.schemaname=current_schema()),
    'triggers',(SELECT jsonb_agg(pg_get_triggerdef(t.oid) ORDER BY r.relname,t.tgname) FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname=current_schema() AND NOT t.tgisinternal),
    'functions',(SELECT jsonb_agg(pg_get_functiondef(p.oid) ORDER BY p.oid::regprocedure::text) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema() AND p.prokind='f'),
    'migrations',(SELECT jsonb_agg(to_jsonb(m) ORDER BY m.version) FROM guild_schema_migrations m)) AS value`);
  const registry = (await db.query<{ value: RegistryRecord }>("SELECT to_jsonb(p) AS value FROM guild_market_providers p ORDER BY p.id")).rows.map(item => item.value);
  return { databaseIdentity: { database: identity.database, schema: identity.schema, serverFingerprint: digest(identity.server) },
    schemaFingerprint: digest(catalog.rows[0]!.value), registryFingerprint: digest(registry), registry };
}

function configuredOrigins(browserOrigin: string, serviceOrigin: string): void {
  accessOriginSchema.parse(browserOrigin); accessOriginSchema.parse(serviceOrigin);
  if (!browserEntryOrigins().includes(browserOrigin) || marketOrigin() !== serviceOrigin) {
    throw new DomainError("SETUP_ORIGIN_CHANGED", "The reviewed browser and service origins must match this exact operator configuration. Existing endpoints will not be retargeted.", 409, false);
  }
}
function deadline(value: string): string {
  z.string().datetime().parse(value);
  const submillisecond = value.match(/\.\d{3}(\d+)Z$/)?.[1];
  if (submillisecond && /[1-9]/.test(submillisecond)) throw new DomainError("SETUP_TIME_PRECISION", "Use an absolute UTC deadline with millisecond precision so the retained browser and database ceilings are identical.", 422, false);
  return new Date(value).toISOString();
}
function checkExisting(row: RegistryRecord, expected: { id: string; endpoint: string; cardUrl: string; kinds: string[] }, syntheticFixture: boolean): void {
  if (row.revoked_at || row.endpoint !== expected.endpoint || row.card_url !== expected.cardUrl || row.provenance !== "guild_controlled_service"
    || row.synthetic_fixture !== syntheticFixture || digest(row.kinds) !== digest(expected.kinds)) {
    throw new DomainError("SETUP_EXISTING_PROVIDER_CHANGED", "An existing service differs from the reviewed controlled identity, endpoint, capabilities or provenance. Prepare a separate configuration migration; this setup changes none of it.", 409, false);
  }
  z.string().uuid().parse(row.owner_identity);
}

export async function planControlledProviderSetup(input: {
  operationId: string; browserOrigin: string; serviceOrigin: string; issuerIdentity: string; syntheticFixture: boolean;
  invitationExpiresAt: string; sessionCeilingAt: string;
}): Promise<{ plan: ControlledProviderSetupPlan; delivery: ProviderInvitationDelivery[] }> {
  z.string().uuid().parse(input.operationId); configuredOrigins(input.browserOrigin, input.serviceOrigin);
  return transaction(async db => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    if ((await db.query("SELECT 1 FROM guild_provider_setup_operations WHERE id=$1", [input.operationId])).rowCount) {
      throw new DomainError("SETUP_OPERATION_EXISTS", "This operation already has a retained result. Inspect it and keep its original private delivery; do not generate replacement invitations.", 409, false);
    }
    const state = await providerSetupState(db), delivery: ProviderInvitationDelivery[] = [];
    const services = CONTROLLED_PROVIDER_IDS.map(id => {
      const definition = providerDefinitions.find(item => item.id === id)!;
      const existing = state.registry.find(row => row.id === id);
      const endpoint = `${input.serviceOrigin}/api/providers/${id}/a2a`, cardUrl = `${input.serviceOrigin}/api/providers/${id}/.well-known/agent-card.json`;
      if (existing) checkExisting(existing, { id, endpoint, cardUrl, kinds: definition.kinds }, input.syntheticFixture);
      const invitationId = randomUUID(), challenge = randomBytes(32).toString("base64url");
      delivery.push({ invitationId, providerId: id, challenge, url: `${input.browserOrigin}/provider/invitations/${invitationId}#challenge=${challenge}` });
      return { id, ownerIdentity: existing?.owner_identity ?? randomUUID(), displayName: existing?.profile.displayName ?? definition.name,
        kinds: definition.kinds, endpoint, cardUrl, existingRowFingerprint: existing ? digest(existing) : null,
        provenance: "guild_controlled_service" as const, invitationId, challengeHash: secretHash(challenge) };
    });
    const value = { version: PROVIDER_SETUP_VERSION, ...input, invitationExpiresAt: deadline(input.invitationExpiresAt), sessionCeilingAt: deadline(input.sessionCeilingAt), createdAt: new Date().toISOString(),
      databaseIdentity: state.databaseIdentity, schemaFingerprint: state.schemaFingerprint, registryFingerprint: state.registryFingerprint, services };
    const plan = controlledProviderSetupPlanSchema.parse({ ...value, digest: digest(value) });
    return { plan, delivery };
  });
}

export async function applyControlledProviderSetup(value: unknown, expectedDigest: string): Promise<{ receipt: ProviderSetupReceipt; retained: boolean }> {
  const plan = controlledProviderSetupPlanSchema.parse(value), { digest: plannedDigest, ...body } = plan;
  if (plannedDigest !== expectedDigest || digest(body) !== plannedDigest) throw new DomainError("SETUP_DIGEST_CHANGED", "The exact reviewed setup digest is required. No registry or invitation was changed.", 409, false);
  if (deadline(plan.invitationExpiresAt) !== plan.invitationExpiresAt || deadline(plan.sessionCeilingAt) !== plan.sessionCeilingAt) {
    throw new DomainError("SETUP_TIME_CHANGED", "Retain the exact canonical deadlines produced by the reviewed dry run.", 409, false);
  }
  configuredOrigins(plan.browserOrigin, plan.serviceOrigin);
  return transaction(async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`guild-provider-setup:${plan.databaseIdentity.database}:${plan.databaseIdentity.schema}`]);
    const state = await providerSetupState(db);
    if (digest(state.databaseIdentity) !== digest(plan.databaseIdentity) || state.schemaFingerprint !== plan.schemaFingerprint) {
      throw new DomainError("SETUP_DATABASE_CHANGED", "The actual database identity or catalog differs from the reviewed setup. Inspect and reconcile it before any write.", 409, false);
    }
    const prior = (await db.query<{ kind: string; request_digest: string; result: ProviderSetupReceipt }>("SELECT kind,request_digest,result FROM guild_provider_setup_operations WHERE id=$1", [plan.operationId])).rows[0];
    if (prior) {
      if (prior.kind !== "controlled_setup" || prior.request_digest !== plan.digest) throw new DomainError("SETUP_OPERATION_CHANGED", "This original operation belongs to a different reviewed request.", 409, false);
      return { receipt: prior.result, retained: true };
    }
    await db.query("LOCK TABLE guild_market_providers, guild_provider_invitations IN SHARE ROW EXCLUSIVE MODE");
    const locked = await providerSetupState(db);
    if (locked.registryFingerprint !== plan.registryFingerprint) throw new DomainError("SETUP_REGISTRY_CHANGED", "The enrolled registry changed after the dry run. The reviewed operation was not applied.", 409, false);
    if (!(await db.query("SELECT 1 WHERE $1::timestamptz>clock_timestamp() AND $2::timestamptz>clock_timestamp()", [plan.invitationExpiresAt, plan.sessionCeilingAt])).rowCount) {
      throw new DomainError("SETUP_EXPIRED", "The original setup invitation or session ceiling expired. It cannot be renewed by applying this plan.", 410, false);
    }
    const receipt: ProviderSetupReceipt = { version: PROVIDER_SETUP_VERSION, operationId: plan.operationId, digest: plan.digest,
      appliedAt: new Date().toISOString(), providersCreated: 0, providersPreserved: 0, invitations: [] };
    for (const service of plan.services) {
      const definition = providerDefinitions.find(item => item.id === service.id)!, existing = locked.registry.find(row => row.id === service.id);
      if (service.endpoint !== `${plan.serviceOrigin}/api/providers/${service.id}/a2a`
        || service.cardUrl !== `${plan.serviceOrigin}/api/providers/${service.id}/.well-known/agent-card.json`
        || digest(service.kinds) !== digest(definition.kinds)) {
        throw new DomainError("SETUP_CAPABILITIES_CHANGED", "The reviewed plan must retain each controlled service's implemented paths and capabilities.", 409, false);
      }
      if ((existing ? digest(existing) : null) !== service.existingRowFingerprint) throw new DomainError("SETUP_PROVIDER_CHANGED", "The original provider row changed after review.", 409, false);
      if (existing) {
        checkExisting(existing, service, plan.syntheticFixture);
        if (existing.owner_identity !== service.ownerIdentity) throw new DomainError("SETUP_OWNER_CHANGED", "The original provider owner changed after review.", 409, false);
        receipt.providersPreserved++;
      } else {
        z.string().uuid().parse(service.ownerIdentity);
        const profile = { displayName: definition.name, ownerDisplayName: `${definition.name} owner`, specialty: definition.specialty, description: definition.description, portfolioUrl: null };
        await db.query("INSERT INTO guild_market_providers(id,profile,monogram,color,kinds,owner_identity,provenance,synthetic_fixture,endpoint,card_url,enrollment_state) VALUES($1,$2,$3,$4,$5,$6,'guild_controlled_service',$7,$8,$9,'policy_required')",
          [service.id, profile, definition.monogram, definition.color, JSON.stringify(service.kinds), service.ownerIdentity, plan.syntheticFixture, service.endpoint, service.cardUrl]);
        receipt.providersCreated++;
      }
      receipt.invitations.push({ id: service.invitationId, providerId: service.id, ownerIdentity: service.ownerIdentity,
        bindingDigest: providerBindingDigest(await providerRow(db, service.id)), expiresAt: plan.invitationExpiresAt, sessionCeilingAt: plan.sessionCeilingAt });
    }
    await db.query("INSERT INTO guild_provider_setup_operations(id,kind,request_digest,request,result) VALUES($1,'controlled_setup',$2,$3,$4)", [plan.operationId, plan.digest, plan, receipt]);
    for (const service of plan.services) {
      const invitation = receipt.invitations.find(item => item.id === service.invitationId)!;
      await db.query("INSERT INTO guild_provider_invitations(id,provider_id,owner_identity,provider_binding_digest,issuer_identity,browser_origin,service_origin,setup_operation_id,challenge_hash,expires_at,session_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [service.invitationId, service.id, service.ownerIdentity, invitation.bindingDigest, plan.issuerIdentity, plan.browserOrigin,
          plan.serviceOrigin, plan.operationId, service.challengeHash, plan.invitationExpiresAt, plan.sessionCeilingAt]);
    }
    return { receipt, retained: false };
  });
}

export async function inspectProviderSetupOperation(operationId: string): Promise<unknown | null> {
  z.string().uuid().parse(operationId);
  return transaction(async db => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    return (await db.query("SELECT kind,request_digest,result,created_at FROM guild_provider_setup_operations WHERE id=$1", [operationId])).rows[0] ?? null;
  });
}

const revokeSchema = z.object({ operationId: z.string().uuid(), invitationId: z.string().uuid(), expectedBindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  issuerIdentity: z.string().trim().min(1).max(240), reason: z.string().trim().min(1).max(1200) }).strict();
export async function revokeProviderInvitation(input: z.infer<typeof revokeSchema>): Promise<unknown> {
  const command = revokeSchema.parse(input), requestDigest = digest(command);
  return transaction(async (db: PoolClient) => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`guild-provider-revoke:${command.operationId}`]);
    const prior = (await db.query<{ kind: string; request_digest: string; result: unknown }>("SELECT kind,request_digest,result FROM guild_provider_setup_operations WHERE id=$1", [command.operationId])).rows[0];
    if (prior) {
      if (prior.kind !== "revoke_invitation" || prior.request_digest !== requestDigest) throw new DomainError("SETUP_OPERATION_CHANGED", "The original revocation identity belongs to another request.", 409, false);
      return prior.result;
    }
    const invitation = (await db.query<{ provider_binding_digest: string; consumed_session_id: string | null; revoked_at: Date | null; revoke_operation_id: string | null }>("SELECT provider_binding_digest,consumed_session_id,revoked_at,revoke_operation_id FROM guild_provider_invitations WHERE id=$1 FOR UPDATE", [command.invitationId])).rows[0];
    if (!invitation || invitation.provider_binding_digest !== command.expectedBindingDigest) throw new DomainError("INVITATION_REVOKE_BINDING", "The exact original invitation binding is required for revocation.", 409, false);
    const revokedAt = invitation.revoked_at?.toISOString() ?? new Date().toISOString();
    const result = { version: "guild.provider-invitation-revocation.v1", operationId: command.operationId, invitationId: command.invitationId,
      originalRevocationOperationId: invitation.revoke_operation_id ?? command.operationId, revokedAt, originalSessionId: invitation.consumed_session_id,
      disclosure: "Only this invitation and its original provider session/credentials are revoked. Existing customer sessions, work, artifacts and financial records are unchanged." };
    await db.query("INSERT INTO guild_provider_setup_operations(id,kind,request_digest,request,result) VALUES($1,'revoke_invitation',$2,$3,$4)", [command.operationId, requestDigest, command, result]);
    if (!invitation.revoked_at) {
      if (invitation.consumed_session_id) {
        await db.query("SELECT id FROM guild_sessions WHERE id=$1 FOR UPDATE", [invitation.consumed_session_id]);
        await db.query("UPDATE guild_sessions SET revoked_at=COALESCE(revoked_at,$2) WHERE id=$1", [invitation.consumed_session_id, revokedAt]);
        await db.query("UPDATE guild_market_provider_sessions SET revoked_at=COALESCE(revoked_at,$2) WHERE session_id=$1", [invitation.consumed_session_id, revokedAt]);
        await db.query("UPDATE guild_market_protocol_clients SET revoked_at=COALESCE(revoked_at,$2) WHERE actor_id=$1 AND access_kind='provider'", [invitation.consumed_session_id, revokedAt]);
      }
      await db.query("UPDATE guild_provider_invitations SET revoked_at=$2,revoke_operation_id=$3 WHERE id=$1", [command.invitationId, revokedAt, command.operationId]);
    }
    return result;
  });
}
