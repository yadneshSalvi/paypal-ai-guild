import { createHmac, timingSafeEqual } from "node:crypto";
import { TaskState, type ListTasksResponse, type Task } from "@a2a-js/sdk";
import { RequestMalformedError } from "@a2a-js/sdk/errors";
import { a2aTimestampNanos } from "./a2a-validation";
import type { MarketDb } from "./registry";

export interface A2ATaskPosition { time: string; id: string }
const oldestTimestamp = "0001-01-01T00:00:00Z";
const malformed = (): never => { throw new RequestMalformedError("The task-list cursor is invalid for this owner, provider or filter."); };
function sign(body: string): Buffer {
  if (!process.env.AUTH_SECRET) throw new Error("AUTH_SECRET is required for retained task cursors.");
  return createHmac("sha256", process.env.AUTH_SECRET).update("guild-market-a2a-list-cursor-v1\0").update(body).digest();
}
export function a2aTaskPosition(task: Task): A2ATaskPosition { return { time: task.status?.timestamp ?? oldestTimestamp, id: task.id }; }
/** Descending effective status time, then a stable task-ID tie break. */
export function compareA2ATaskPositions(left: A2ATaskPosition, right: A2ATaskPosition): number {
  const a = a2aTimestampNanos(left.time), b = a2aTimestampNanos(right.time);
  return a === b ? left.id === right.id ? 0 : left.id < right.id ? 1 : -1 : a < b ? 1 : -1;
}
export function encodeA2ATaskCursor(position: A2ATaskPosition, scope: string): string {
  const body = Buffer.from(JSON.stringify({ v: 1, scope, ...position })).toString("base64url");
  return `${body}.${sign(body).toString("base64url")}`;
}
export function decodeA2ATaskCursor(token: string, scope: string): A2ATaskPosition {
  if (token.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) return malformed();
  const [body, signature] = token.split(".") as [string, string], actual = Buffer.from(signature, "base64url"), expected = sign(body);
  if (actual.toString("base64url") !== signature || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return malformed();
  let value: unknown;
  try { value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return malformed(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) return malformed();
  const parsed = value as Record<string, unknown>;
  if (Object.keys(parsed).sort().join(",") !== "id,scope,time,v" || parsed.v !== 1 || parsed.scope !== scope
    || typeof parsed.time !== "string" || typeof parsed.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(parsed.id)) return malformed();
  a2aTimestampNanos(parsed.time);
  return { time: parsed.time, id: parsed.id };
}

const receiptTimestamp = `coalesce(r.task#>>'{status,timestamp}', '${oldestTimestamp}')`;
// PostgreSQL timestamps retain microseconds; a JSON Timestamp can have nine
// fractional digits. Parse whole seconds and the fraction separately so SQL
// keysets agree exactly with the UTC nanosecond comparator used on the wire.
const receiptNanos = `(extract(epoch FROM ((left(${receiptTimestamp},19)||'Z')::timestamptz))*1000000000
  + rpad(coalesce(substring(${receiptTimestamp} FROM '[.]([0-9]{1,9})Z$'),''),9,'0')::numeric)`;
const projection = `WITH owned AS (
  SELECT task_id,task FROM guild_market_protocol_receipts
  WHERE provider_id=$1 AND tenant_id=$2 AND actor_id=$3 AND ($4::text IS NULL OR task->>'contextId'=$4)
), projected AS (
  SELECT r.task_id,r.task#>>'{status,state}' AS retained_state,w.id IS NOT NULL AS has_work,
    CASE WHEN w.id IS NULL THEN ${receiptNanos}
      ELSE extract(epoch FROM date_trunc('milliseconds',coalesce(j.updated_at,w.updated_at)))*1000000000 END AS status_time
  FROM owned r
  LEFT JOIN LATERAL (
    SELECT h.message FROM jsonb_array_elements(r.task->'history') WITH ORDINALITY h(message,ordinal)
    WHERE h.message->>'role'='ROLE_AGENT' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(h.message->'parts') p(part) WHERE p.part->'data'->>'version'='guild.market-service-result.v1'
    ) ORDER BY h.ordinal DESC LIMIT 1
  ) reply ON true
  LEFT JOIN LATERAL (
    SELECT p.part->'data' AS result FROM jsonb_array_elements(reply.message->'parts') WITH ORDINALITY p(part,ordinal)
    WHERE p.part ? 'data' ORDER BY p.ordinal LIMIT 1
  ) response ON true
  LEFT JOIN guild_market_tasks w ON response.result->>'ok'='true' AND response.result->>'taskId'=w.id::text
    AND w.provider_id=$1 AND w.tenant_id=$2 AND w.actor_id=$3
  LEFT JOIN guild_jobs j ON j.id=w.original_job_id AND j.tenant_id=w.tenant_id AND j.commission_id=w.commission_id
)`;
const timeFilter = `($5::numeric IS NULL OR status_time >= $5::numeric)`;
interface Candidate { task_id: string; status_time: string }
interface PageQuery {
  providerId: string; tenantId: string; actorId: string; contextId: string; after?: bigint;
  status: TaskState; pageSize: number; cursor: A2ATaskPosition | null; scope: string; includeArtifacts: boolean;
}

/** Scope and keyset predicates run in SQL before a page is materialized. Work
 * status can change to input-required when artifact integrity is withheld, so
 * status-filtered totals verify those work-backed candidates through readTask.
 * That scan uses bounded keyset batches and retains at most one page in memory.
 * The caller supplies one repeatable-read, read-only connection for all reads. */
export async function readA2ATaskPage(db: MarketDb, query: PageQuery, readTask: (id: string) => Promise<Task>): Promise<ListTasksResponse> {
  const base = [query.providerId, query.tenantId, query.actorId, query.contextId || null, query.after?.toString() ?? null];
  const state = query.status ? TaskState[query.status] : null;
  const filter = `${timeFilter} AND ($6::text IS NULL OR (NOT has_work AND retained_state=$6))`;
  const page = [...base, state, query.cursor ? a2aTimestampNanos(query.cursor.time).toString() : null, query.cursor?.id ?? null, query.pageSize + 1];
  const total = (await db.query<{ count: string }>(`${projection} SELECT count(*)::text AS count FROM projected WHERE ${filter}`, page.slice(0, 6))).rows[0]!;
  let totalSize = Number(total.count);
  const workPage: Task[] = [];
  if (state) {
    let position: Candidate | undefined;
    for (;;) {
      const batch = (await db.query<Candidate>(`${projection} SELECT task_id,status_time::text FROM projected
        WHERE has_work AND ${timeFilter} AND ($6::numeric IS NULL OR status_time < $6::numeric OR (status_time=$6::numeric AND task_id::text < $7))
        ORDER BY status_time DESC,task_id DESC LIMIT $8`, [...base, position?.status_time ?? null, position?.task_id ?? null, 100])).rows;
      for (const candidate of batch) {
        const task = await readTask(candidate.task_id);
        if (task.status?.state !== query.status) continue;
        totalSize++;
        if ((!query.cursor || compareA2ATaskPositions(a2aTaskPosition(task), query.cursor) > 0) && workPage.length <= query.pageSize) workPage.push(task);
      }
      if (batch.length < 100) break;
      position = batch[batch.length - 1]!;
    }
  }
  const candidates = (await db.query<Candidate>(`${projection} SELECT task_id,status_time::text FROM projected WHERE ${filter}
    AND ($7::numeric IS NULL OR status_time < $7::numeric OR (status_time=$7::numeric AND task_id::text < $8))
    ORDER BY status_time DESC,task_id DESC LIMIT $9`, page)).rows;
  const tasks = [...workPage];
  for (const candidate of candidates) tasks.push(await readTask(candidate.task_id));
  tasks.sort((a, b) => compareA2ATaskPositions(a2aTaskPosition(a), a2aTaskPosition(b)));
  const selected = tasks.slice(0, query.pageSize);
  return { tasks: selected.map(task => query.includeArtifacts ? task : { ...task, artifacts: [] }), totalSize, pageSize: query.pageSize,
    nextPageToken: tasks.length > query.pageSize ? encodeA2ATaskCursor(a2aTaskPosition(selected[selected.length - 1]!), query.scope) : "" };
}
