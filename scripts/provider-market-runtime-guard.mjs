/** Preload for the controlled local Next qualification, not an OS sandbox. */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import http2 from "node:http2";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";

const hash = value => createHash("sha256").update(value).digest("hex");
const original = {
  realpath: fs.realpathSync, append: fs.appendFileSync, write: fs.writeFileSync,
  read: fs.readFile, readSync: fs.readFileSync, open: fs.open, openSync: fs.openSync,
  promiseRead: fsp.readFile, promiseOpen: fsp.open, stream: fs.createReadStream,
  readdir: fs.readdir, readdirSync: fs.readdirSync, promiseReaddir: fsp.readdir,
  opendir: fs.opendir, opendirSync: fs.opendirSync, promiseOpendir: fsp.opendir,
  fetch: globalThis.fetch, connect: net.Socket.prototype.connect, request: http.request, get: http.get,
};
const required = name => { const value = process.env[name]; if (!value) throw Error(`Missing qualification guard setting: ${name}`); return value; };
const appRoot = original.realpath(required("GUILD_QUAL_PROJECT_ROOT"));
const evidenceRoot = original.realpath(required("GUILD_NEXT_EVIDENCE_DIR"));
const origin = new URL(required("GUILD_NEXT_HTTP_ORIGIN"));
if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1" || !origin.port || origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) throw Error("Invalid owned qualification origin");
const protectedRoots = JSON.parse(required("GUILD_QUAL_PROTECTED_ROOTS")).map(value => original.realpath(value));
if (!protectedRoots.length) throw Error("A protected workspace root is required");
const operationId = required("GUILD_QUAL_OPERATION_ID");
if (!/^[a-f0-9]{24}$/.test(operationId)) throw Error("Invalid qualification operation identity");
const databaseEndpoint = JSON.parse(process.env.GUILD_QUAL_DATABASE_ENDPOINT ?? "null");
if (databaseEndpoint && !(databaseEndpoint.kind === "unix" && path.isAbsolute(databaseEndpoint.path) && databaseEndpoint.path.endsWith("/.s.PGSQL.55568")
  || databaseEndpoint.kind === "tcp" && ["127.0.0.1", "::1"].includes(databaseEndpoint.host) && databaseEndpoint.port === 55568)) throw Error("Invalid restricted database endpoint");
const guardPath = fileURLToPath(import.meta.url);
const tracePath = path.join(evidenceRoot, `guard-${operationId}-${process.pid}.jsonl`);
const inside = (value, root) => value === root || value.startsWith(root + path.sep);
const allowed = value => inside(value, appRoot) || inside(value, evidenceRoot);
function trace(value) { original.append(tracePath, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...value }) + "\n", { mode: 0o600 }); }
function denied(kind, value) {
  trace({ type: kind, ...(value === undefined ? {} : { pathHash: hash(value) }) });
  throw Object.assign(Error(kind === "denied-env-file" ? "Environment-file loading is denied" : "Qualification access outside the owned boundary is denied"), { code: kind === "denied-env-file" ? "ENOENT" : "EACCES" });
}
function canonical(value) {
  let current = value; const suffix = [];
  for (;;) {
    try { return path.join(original.realpath(current), ...suffix.reverse()); }
    catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
      const parent = path.dirname(current); if (parent === current) throw error;
      suffix.push(path.basename(current)); current = parent;
    }
  }
}
function readable(value) {
  // File descriptors can only be inherited stdio or opened after this preload;
  // every normal open path is checked below, including openSync/FileHandle.
  if (typeof value === "number") return;
  if (Buffer.isBuffer(value)) value = value.toString();
  if (typeof value !== "string" && !(value instanceof URL)) return;
  const lexical = path.resolve(value instanceof URL ? fileURLToPath(value) : value), actual = canonical(lexical);
  for (const name of [path.basename(lexical), path.basename(actual)]) if (name.startsWith(".env") && name !== ".env.example") denied("denied-env-file", lexical);
  if (allowed(lexical) && !allowed(actual) || protectedRoots.some(root => inside(actual, root) && !allowed(actual) || inside(lexical, root) && !allowed(lexical))) denied("denied-protected-read", lexical);
}
function callbackRead(method) {
  return function (value, ...args) {
    try { readable(value); } catch (error) { const callback = args.at(-1); if (typeof callback === "function") return queueMicrotask(() => callback(error)); throw error; }
    return method.call(this, value, ...args);
  };
}
fs.readFile = callbackRead(original.read);
fs.open = callbackRead(original.open);
fs.readdir = callbackRead(original.readdir);
fs.opendir = callbackRead(original.opendir);
fs.readFileSync = function (value, ...args) { readable(value); return original.readSync.call(this, value, ...args); };
fs.openSync = function (value, ...args) { readable(value); return original.openSync.call(this, value, ...args); };
fs.createReadStream = function (value, ...args) { readable(value); return original.stream.call(this, value, ...args); };
fs.readdirSync = function (value, ...args) { readable(value); return original.readdirSync.call(this, value, ...args); };
fs.opendirSync = function (value, ...args) { readable(value); return original.opendirSync.call(this, value, ...args); };
fsp.readFile = async function (value, ...args) { readable(value); return original.promiseRead.call(this, value, ...args); };
fsp.open = async function (value, ...args) { readable(value); return original.promiseOpen.call(this, value, ...args); };
fsp.readdir = async function (value, ...args) { readable(value); return original.promiseReaddir.call(this, value, ...args); };
fsp.opendir = async function (value, ...args) { readable(value); return original.promiseOpendir.call(this, value, ...args); };

function ownedUrl(value) {
  let url; try { url = new URL(value); } catch { return denied("denied-network"); }
  if (url.origin !== origin.origin || url.username || url.password) return denied("denied-network");
  return url;
}
globalThis.fetch = async (input, options = {}) => {
  const url = ownedUrl(input instanceof Request ? input.url : String(input));
  const response = await original.fetch(input, { ...options, redirect: options.redirect === "manual" ? "manual" : "error" });
  // Queries, headers and bodies can contain one-use challenges or credentials.
  trace({ type: "fetch", method: options.method ?? (input instanceof Request ? input.method : "GET"), path: url.pathname, status: response.status });
  return response;
};
function checkHttp(args) {
  const input = args[0], extra = typeof args[1] === "object" && args[1] !== null ? args[1] : {};
  let options;
  if (typeof input === "string" || input instanceof URL) {
    const url = ownedUrl(input);
    options = { protocol: url.protocol, hostname: url.hostname, port: url.port, ...extra };
  } else options = input ?? {};
  if (options.socketPath) return denied("denied-network");
  const host = options.hostname ?? options.host ?? "localhost", port = Number(options.port ?? 80);
  if ((options.protocol ?? "http:") !== "http:" || host !== "127.0.0.1" || port !== Number(origin.port)) denied("denied-network");
}
http.request = function (...args) { checkHttp(args); return original.request.apply(this, args); };
http.get = function (...args) { checkHttp(args); return original.get.apply(this, args); };
https.request = https.get = () => denied("denied-network");
tls.connect = http2.connect = () => denied("denied-network");
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first && typeof first === "object" ? first : typeof first === "number" ? { port: first, host: typeof args[1] === "string" ? args[1] : "localhost" } : { path: first };
  if (options.path && !options.port) {
    if (databaseEndpoint?.kind === "unix" && path.resolve(options.path) === databaseEndpoint.path) return original.connect.apply(this, args);
    return denied("denied-network");
  }
  const host = options.host ?? options.hostname ?? "localhost", port = Number(options.port);
  if (host === "127.0.0.1" && port === Number(origin.port) || databaseEndpoint?.kind === "tcp" && host === databaseEndpoint.host && port === databaseEndpoint.port) return original.connect.apply(this, args);
  return denied("denied-network");
};
process.loadEnvFile = () => denied("denied-env-file");

if (process.env.GUILD_QUAL_RUNTIME_ID) {
  const record = { version: "guild.market-runtime-guard-owner.v1", pid: process.pid, cwd: process.cwd(), execPath: process.execPath,
    operationId, runtimeIdHash: hash(process.env.GUILD_QUAL_RUNTIME_ID), origin: origin.origin,
    guardSha256: hash(original.readSync(guardPath)), at: new Date().toISOString() };
  original.write(path.join(evidenceRoot, `runtime-guard-${operationId}-${process.pid}.json`), JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx" });
}
trace({ type: "guard-ready", mode: process.env.GUILD_QUAL_MODE, databaseEnabled: !!databaseEndpoint });
syncBuiltinESMExports();
