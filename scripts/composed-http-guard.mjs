// Actual local HTTP only. Provider transport and environment-file loading stay
// denied, and redirects cannot escape the exact isolated composition listener.
const localFetch = globalThis.fetch;
await import("./hosted-test-guard.mjs");
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.origin !== "http://localhost:4550" || url.username || url.password) throw Error("Only the exact composition HTTP fixture origin is allowed.");
  return localFetch(input, { ...init, redirect: "manual" });
};
