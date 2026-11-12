import { errorResponse } from "../http";

export function publicationJson(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
}
export function publicationError(error: unknown) {
  const response = errorResponse(error); response.headers.set("Cache-Control", "private, no-store"); return response;
}
