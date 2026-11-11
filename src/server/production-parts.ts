import { z } from "zod";
import { digest } from "@/domain/primitives";
import { getPool } from "./db";
import type { ProductionLease } from "./production-authority";
import { ProductionReviewRequired } from "./production-continuation";

export async function savedProductionPart<T extends z.ZodType>(context: ProductionLease, key: string, inputHash: string, schema: T): Promise<z.infer<T> | null> {
  const row = (await getPool().query<{ input_hash: string; output_hash: string; output: unknown }>("SELECT input_hash,output_hash,output FROM guild_production_parts WHERE tenant_id=$1 AND job_id=$2 AND part_key=$3", [context.tenantId, context.jobId, key])).rows[0];
  if (!row) return null;
  if (row.input_hash !== inputHash || row.output_hash !== digest(row.output)) throw new ProductionReviewRequired("PRODUCTION_PART_CHANGED", "A saved part belongs to different inputs or changed content. The original is retained for review.");
  const result = schema.safeParse(row.output);
  if (!result.success) throw new ProductionReviewRequired("PRODUCTION_PART_FORMAT", "A saved part no longer matches its agreed output contract.");
  return result.data;
}

export async function saveProductionPart<T extends z.ZodType>(context: ProductionLease, key: string, inputHash: string, output: z.infer<T>, schema: T): Promise<z.infer<T>> {
  const checked = schema.parse(output);
  await getPool().query("INSERT INTO guild_production_parts(tenant_id,job_id,part_key,input_hash,output_hash,output) SELECT $1,$2,$3,$4,$5,$6 FROM guild_jobs WHERE id=$2 AND tenant_id=$1 ON CONFLICT(tenant_id,job_id,part_key) DO NOTHING", [context.tenantId, context.jobId, key, inputHash, digest(checked), checked]);
  const saved = await savedProductionPart(context, key, inputHash, schema);
  if (!saved || digest(saved) !== digest(checked)) throw new ProductionReviewRequired("PRODUCTION_PART_CONFLICT", "Another result already owns this saved part. No existing output was overwritten.");
  return saved;
}
