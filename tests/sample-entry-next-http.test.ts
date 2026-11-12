import assert from "node:assert/strict";
import test from "node:test";
import { runSampleEntryNextQualification } from "../scripts/check-sample-entry-next-http";
test("actual isolated Next explicit Sample admission and original recovery",{
  skip:!process.env.GUILD_NEXT_TEST_SCHEMA?.startsWith("guild_entry_next_worker_"),timeout:180_000,
},async()=>{const report=await runSampleEntryNextQualification();assert.equal(report.passed,true,JSON.stringify({failures:report.failures,reportPath:report.reportPath}));assert.ok(report.checks.length>=17);assert.equal(report.actualNext,true);assert.equal(report.nativeBrowser,false);});
