interface RecoveryOperations {
  payment: () => Promise<unknown>;
  webhooks: () => Promise<unknown>;
  hostedOriginal: () => Promise<unknown>;
  production: () => Promise<unknown>;
}

/** Financial recovery starts before the bounded original-browser read. A held
 * browser outcome cannot delay those financial operations or erase their own
 * results. Production retains its existing ordering after the original read. */
export async function recoverSavedWork(operations: RecoveryOperations) {
  const financial = Promise.allSettled([operations.payment(), operations.webhooks()]);
  const hostedBrowser = await operations.hostedOriginal().catch(() => ({ state: "held" }));
  const production = await Promise.allSettled([operations.production()]);
  const outcomes = [production[0]!, ...await financial];
  const value = (index: number) => { const result = outcomes[index]!; return result.status === "fulfilled" ? result.value : { state: "recoverable" }; };
  return { ok: true, hostedBrowser, production: value(0), payments: value(1), webhooks: value(2) };
}
