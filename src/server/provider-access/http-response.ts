import { ZodError } from "zod";
import { PROVIDER_ACCESS_VERSION, type ProviderAccessError } from "@/contracts/provider-access";
import { DomainError } from "@/domain/primitives";
import { readJson } from "../http";
import { privateMcpResponse } from "../provider-market/mcp-http";

export function accessError(error: unknown): { status: number; error: ProviderAccessError } {
  if (error instanceof DomainError) return { status: error.status, error: { code: error.code, message: error.message, retryable: error.recoverable, unknownOutcome: false } };
  if (error instanceof ZodError) return { status: 400, error: { code: "ACCESS_INPUT", message: "Check the original request fields before continuing.", retryable: false, unknownOutcome: false } };
  return { status: 503, error: { code: "ACCESS_RESPONSE_UNKNOWN", message: "The response could not be confirmed. Keep the original request identity and inspect its retained result before starting another action.", retryable: true, unknownOutcome: true } };
}

export function accessErrorResponse(error: unknown, head = false): Response {
  const mapped = accessError(error);
  return privateMcpResponse(new Response(head ? null : JSON.stringify({ version: PROVIDER_ACCESS_VERSION, ok: false, error: mapped.error }),
    { status: mapped.status, headers: { "Content-Type": "application/json; charset=utf-8" } }));
}

export async function accessJson(request: Request, maxBytes = 8192): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new DomainError("ACCESS_BODY_TYPE", "This action requires its original JSON request.", 415, false);
  }
  return readJson(request, maxBytes);
}
