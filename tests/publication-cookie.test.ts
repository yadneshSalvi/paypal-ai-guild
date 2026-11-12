import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

function configured(value?: string) {
  const env = { ...process.env }; delete env.GUILD_SESSION_COOKIE;
  if (value !== undefined) env.GUILD_SESSION_COOKIE = value;
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", 'const {SESSION_COOKIE}=await import("./src/server/session.ts"); process.stdout.write(SESSION_COOKIE);'], { encoding: "utf8", env });
}
test("isolated cookie naming leaves the normal default and rejects header delimiters, empty and oversized names", () => {
  const standard = configured(); assert.equal(standard.status, 0); assert.equal(standard.stdout, "guild_session");
  const isolated = configured("guild_publication_v1"); assert.equal(isolated.status, 0); assert.equal(isolated.stdout, "guild_publication_v1");
  for (const name of ["", "guild; HttpOnly", "guild=session", "guild cookie", "guild\r\n", "_guild", "g".repeat(65)]) {
    const result = configured(name); assert.notEqual(result.status, 0, name); assert.equal(result.stdout, ""); assert.match(result.stderr, /GUILD_SESSION_COOKIE must be/);
  }
});
