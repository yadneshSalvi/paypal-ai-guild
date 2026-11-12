import { randomBytes, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { AGENT_ACCESS_VERSION, AGENT_COMMAND_STATUS_VERSION, CUSTOMER_AGENT_SCOPES, PROVIDER_AGENT_SCOPES,
  agentAccessCommandSchema, type AgentAccessCommand, type AgentAccessCommandResult, type AgentAccessCommandStatus, type AgentAccessScope } from "@/contracts/provider-access";
import { digest, DomainError } from "@/domain/primitives";
import { transaction } from "../db";
import type { Session } from "../session";
import type { MarketDb } from "../provider-market/registry";
import { accessError } from "./http-response";
import { requireAccessActor, secretHash, type AccessActor } from "./identity";
import { clientSummary, ownClient, type AccessClientRow } from "./clients";

interface CommandRow { scope: AgentAccessScope; request_digest: string; request: AgentAccessCommand; result: AgentAccessCommandResult }

function retainedResult(result: AgentAccessCommandResult): AgentAccessCommandResult {
  if (result.state !== "issued_now") return result;
  return { version: result.version, commandId: result.commandId, ok: true, state: "retained", credential: result.credential,
    tokenAvailability: "unavailable", message: "The original credential was issued. Its raw token is not recoverable. If it was not retained privately, explicitly revoke it before issuing a new credential." };
}

async function currentResult(db: MarketDb, actor: AccessActor, result: AgentAccessCommandResult): Promise<AgentAccessCommandResult> {
  const safe = retainedResult(result);
  if (!safe.ok) return safe;
  return { ...safe, credential: clientSummary(await ownClient(db, actor, safe.credential.id), actor) };
}

async function applyCommand(db: PoolClient, actor: AccessActor, command: AgentAccessCommand): Promise<AgentAccessCommandResult> {
  const common = { version: AGENT_ACCESS_VERSION, commandId: command.commandId, ok: true as const };
  if (command.type === "revoke_credential") {
    const client = await ownClient(db, actor, command.clientId, true);
    const row = client.revoked_at ? client : (await db.query<AccessClientRow>("UPDATE guild_market_protocol_clients SET revoked_at=clock_timestamp() WHERE id=$1 AND actor_id=$2 AND tenant_id=$3 RETURNING *", [client.id, actor.session.id, actor.session.tenantId])).rows[0]!;
    return { ...common, state: "revoked", credential: clientSummary(row, actor), tokenAvailability: "unavailable", message: "The original credential is revoked. Its identity, scope and history remain retained." };
  }
  const allowed: readonly string[] = actor.scope === "provider" ? PROVIDER_AGENT_SCOPES : CUSTOMER_AGENT_SCOPES;
  if (command.scopes.some(scope => !allowed.includes(scope))) throw new DomainError("CLIENT_SCOPE", "Choose only scopes belonging to this fixed customer or provider entry.", 422, false);
  if (Date.parse(command.expiresAt) <= Date.now() || Date.parse(command.expiresAt) > Date.parse(actor.session.expiresAt)) {
    throw new DomainError("CLIENT_EXPIRY", "The credential needs a future expiry within the original session ceiling. This action cannot renew that session.", 422, false);
  }
  const id = randomUUID(), token = `${actor.scope === "provider" ? "gp" : "gc"}_${randomBytes(32).toString("base64url")}`;
  const row = (await db.query<AccessClientRow>("INSERT INTO guild_market_protocol_clients(id,tenant_id,actor_id,token_hash,scopes,provider_id,expires_at,access_kind,label,token_prefix,owner_identity,issued_command_id) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12 WHERE EXISTS(SELECT 1 FROM guild_sessions WHERE id=$3 AND tenant_id=$2 AND revoked_at IS NULL AND expires_at>clock_timestamp() AND expires_at>=$7) RETURNING *",
    [id, actor.session.tenantId, actor.session.id, secretHash(token), JSON.stringify(command.scopes), actor.provider?.id ?? null,
      command.expiresAt, actor.scope, command.label, token.slice(0, 11), actor.provider?.owner_identity ?? null, command.commandId])).rows[0];
  if (!row) throw new DomainError("CLIENT_AUTHORITY_EXPIRED", "The original session expired before issuance. No credential was created.", 410, false);
  return { ...common, state: "issued_now", credential: clientSummary(row, actor), tokenAvailability: "shown_once", token,
    message: "Copy this token into your private agent configuration now. Guild retains only its hash and safe summary; it will not be returned again." };
}

export async function executeAgentAccessCommand(session: Session, scope: AgentAccessScope, value: unknown): Promise<AgentAccessCommandResult> {
  const command = agentAccessCommandSchema.parse(value), requestDigest = digest({ scope, command });
  return transaction(async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`guild-agent-access:${session.id}:${command.commandId}`]);
    await db.query("SELECT id FROM guild_sessions WHERE id=$1 AND tenant_id=$2 FOR UPDATE", [session.id, session.tenantId]);
    const actor = await requireAccessActor(db, session, scope);
    const prior = (await db.query<CommandRow>("SELECT scope,request_digest,request,result FROM guild_provider_access_commands WHERE actor_id=$1 AND tenant_id=$2 AND command_id=$3", [session.id, session.tenantId, command.commandId])).rows[0];
    if (prior) {
      if (prior.scope !== scope || prior.request_digest !== requestDigest) throw new DomainError("CLIENT_COMMAND_CHANGED", "This command identity belongs to a different original decision. Inspect that retained result before starting a new action.", 409, false);
      return currentResult(db, actor, prior.result);
    }
    await db.query("SAVEPOINT agent_access_action");
    let result: AgentAccessCommandResult;
    try { result = await applyCommand(db, actor, command); }
    catch (error) {
      if (!(error instanceof DomainError)) throw error;
      await db.query("ROLLBACK TO SAVEPOINT agent_access_action");
      result = { version: AGENT_ACCESS_VERSION, commandId: command.commandId, ok: false, state: "refused", message: error.message,
        error: accessError(error).error, tokenAvailability: "unavailable" };
    }
    await db.query("RELEASE SAVEPOINT agent_access_action");
    await db.query("INSERT INTO guild_provider_access_commands(actor_id,tenant_id,command_id,scope,request_digest,request,result) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [session.id, session.tenantId, command.commandId, scope, requestDigest, command, retainedResult(result)]);
    return result;
  });
}

export async function agentAccessCommandStatus(session: Session, scope: AgentAccessScope, commandId: string): Promise<AgentAccessCommandStatus> {
  return transaction(async db => {
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const actor = await requireAccessActor(db, session, scope);
    const prior = (await db.query<CommandRow>("SELECT scope,request_digest,request,result FROM guild_provider_access_commands WHERE actor_id=$1 AND tenant_id=$2 AND command_id=$3", [session.id, session.tenantId, commandId])).rows[0];
    const common = { version: AGENT_COMMAND_STATUS_VERSION, commandId, serverTime: new Date().toISOString(), tokenAvailability: "unavailable" as const };
    if (!prior || prior.scope !== scope) return { ...common, operation: null, state: "not_found", credential: null, error: null,
      message: "No committed result is visible for this original command. A concurrent request may still be finishing. Keep its identity and check again; no replacement credential has been issued." };
    const result = await currentResult(db, actor, prior.result);
    return { ...common, operation: prior.request.type, state: result.ok ? "completed" : "refused", credential: result.ok ? result.credential : null,
      error: result.ok ? null : result.error, message: result.message };
  });
}
