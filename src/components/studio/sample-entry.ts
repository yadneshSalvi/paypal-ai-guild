import { sampleEntryRequestSchema, type SampleEntryRequest } from "@/contracts/sample-entry";

export const SAMPLE_ENTRY_STORAGE = "guild:sample-entry:v1";
export function retainedSampleEntry(storage: Pick<Storage,"getItem">): SampleEntryRequest | null {
  try {
    const saved = storage.getItem(SAMPLE_ENTRY_STORAGE); if (!saved) return null;
    const parsed = sampleEntryRequestSchema.safeParse(JSON.parse(saved));
    if (parsed.success) return parsed.data;
  } catch { /* An unreadable original request must never be replaced implicitly. */ }
  throw new Error("The original Sample entry could not be read. No new Sample was started.");
}
export function prepareSampleEntry(storage: Pick<Storage,"getItem"|"setItem">): SampleEntryRequest {
  const original = retainedSampleEntry(storage); if (original) return original;
  const proof = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
  const request = sampleEntryRequestSchema.parse({ version:"guild.sample-entry.v1",intent:"open_sample",requestId:crypto.randomUUID(),proof,requestedAt:new Date().toISOString() });
  try { storage.setItem(SAMPLE_ENTRY_STORAGE, JSON.stringify(request)); }
  catch { throw new Error("This tab could not retain its original entry request. No Sample was started. Enable tab storage and try again."); }
  return request;
}
export function clearSampleEntry(storage: Pick<Storage,"getItem"|"removeItem">, requestId?: string): void {
  const original = retainedSampleEntry(storage); if (original && (!requestId || original.requestId === requestId)) storage.removeItem(SAMPLE_ENTRY_STORAGE);
}
