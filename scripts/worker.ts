export {};
try { process.loadEnvFile(".env"); } catch { /* Hosting injects environment. */ }
const { runNextJob } = await import("../src/server/jobs");
const { getPool } = await import("../src/server/db");
const { recoverPaymentWork } = await import("../src/server/payments/service");
const { recoverWebhookObservations } = await import("../src/server/payments/webhooks");
const { paymentRuntime } = await import("../src/server/payments/runtime");
const once = process.argv.includes("--once"), productionOnly = process.argv.includes("--production-only"); let stopping = false, nextPaymentsAt = 0;
process.on("SIGINT", () => { stopping = true; }); process.on("SIGTERM", () => { stopping = true; });
do {
  const result = await runNextJob();
  if (result) console.log(JSON.stringify({ jobId: result.id, state: result.state }));
  if (!productionOnly && Date.now() >= nextPaymentsAt) {
    const work = await Promise.allSettled([recoverPaymentWork(), recoverWebhookObservations()]);
    for (const [index, outcome] of work.entries()) console.log(JSON.stringify({ work: index === 0 ? "payment_recovery" : "webhook_observations", result: outcome.status === "fulfilled" ? outcome.value : { state: "recoverable" } }));
    nextPaymentsAt = Date.now() + 15000;
  }
  if (!once && !result) await new Promise(resolve => setTimeout(resolve, 2000));
} while (!once && !stopping);
await getPool().end();
if (!productionOnly) try { await paymentRuntime().db.close(); } catch { /* An unconfigured financial runtime may never have started. */ }
