#!/usr/bin/env python3
"""Own one clean Next qualification. No dotenv, copied build, or fixture reset."""
from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import hashlib
import json
import os
import pathlib
import re
import secrets
import shutil
import signal
import socket
import stat
import subprocess
import sys
import time
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent.parent
GUARD = ROOT / "scripts/provider-market-runtime-guard.mjs"
EMPTY_KEYS = ("OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY",
              "ANTHROPIC_API_KEY", "DEEPGRAM_API_KEY", "BLOB_READ_WRITE_TOKEN", "PAYPAL_CLIENT_ID",
              "PAYPAL_CLIENT_SECRET", "PAYPAL_ACCESS_TOKEN", "VERCEL_OIDC_TOKEN", "AI_GATEWAY_API_KEY")
MODES = ("freeze", "refreeze", "build", "archive-build", "typecheck", "prepare", "start", "test", "check", "status", "stop-owned")


class Refused(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise Refused(message)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def sha(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def within(path, root):
    return path == root or root in path.parents


def private_file(path):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink(), "A private input must be a regular file, not a link.")
    require(info.st_uid == os.getuid() and info.st_mode & 0o077 == 0, "Private inputs must be owned by this user and have mode0600.")
    return path


def read_json(path):
    return json.loads(private_file(path).read_text())


def write_new(path, value):
    payload = json.dumps(value, indent=2) + "\n"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    return path


def replace_pointer(path, value):
    if path.exists():
        private_file(path)
    temporary = path.parent / (".pointer-" + secrets.token_hex(8))
    write_new(temporary, value)
    os.replace(temporary, path)


def tool(name):
    value = shutil.which(name)
    require(value is not None, "Required local executable is missing: " + name)
    return str(pathlib.Path(value).resolve())


def system_env(node=None):
    return {"PATH": (str(pathlib.Path(node).parent) + os.pathsep if node else "") + os.defpath,
            "LANG": "en_US.UTF-8", "TZ": "UTC", "NEXT_TELEMETRY_DISABLED": "1"}


def system_output(argv, check=True):
    result = subprocess.run(argv, env=system_env(), capture_output=True, text=True)
    require(not check or result.returncode == 0, "A local process ownership check failed.")
    return result


def source_inputs():
    result = subprocess.run([tool("git"), "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
                            cwd=ROOT, env={**system_env(), "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull},
                            capture_output=True, check=True)
    paths = {ROOT / name.decode() for name in result.stdout.split(b"\0") if name}
    if (ROOT / "next-env.d.ts").is_file():
        paths.add(ROOT / "next-env.d.ts")
    rows = []
    for path in sorted(paths):
        if not path.is_file():
            continue
        require(within(path.resolve(), ROOT), "A source input resolves outside this checkout.")
        name = path.relative_to(ROOT).as_posix()
        require(not path.name.startswith(".env") or path.name == ".env.example", "An environment file is present in the source inventory.")
        rows.append({"path": name, "sha256": sha(path), "bytes": path.stat().st_size,
                     **({"symlink": os.readlink(path)} if path.is_symlink() else {})})
    require(all(any(row["path"].startswith(prefix + "/") for row in rows) for prefix in ("src", "scripts", "tests")), "Source, scripts and tests must all be included in the freeze.")
    return rows


def no_environment_files():
    require(not any(path.name.startswith(".env") and path.name != ".env.example" for path in ROOT.iterdir()), "Remove environment files from this isolated checkout; none will be loaded.")


def source_changes(before, after):
    a = {item["path"]: item for item in before}
    b = {item["path"]: item for item in after}
    return sorted(name for name in a.keys() | b.keys() if a.get(name) != b.get(name))


def build_inputs():
    directory = ROOT / ".next"
    require(directory.is_dir() and not directory.is_symlink(), "An owned clean build is required.")
    rows = []
    for path in sorted(directory.rglob("*")):
        if not path.is_file():
            continue
        require(within(path.resolve(), directory), "A build file resolves outside this checkout.")
        name = path.relative_to(directory).as_posix()
        # Runtime caches/traces are retained separately, not executable build identity.
        if name.split("/")[0] in ("cache", "diagnostics", "trace", "trace-build"):
            continue
        rows.append({"path": name, "sha256": sha(path), "bytes": path.stat().st_size})
    return rows


PREFLIGHT = r'''
import {createRequire} from "node:module";
const {Pool}=createRequire(process.cwd()+"/package.json")("pg"),pool=new Pool({connectionString:process.env.DATABASE_URL,max:1});
try {
 await pool.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
 const row=(await pool.query("SELECT current_setting('port')::int AS port,current_schema() AS schema,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
 if(!row||row.port!==55568||[row.rolsuper,row.rolcreatedb,row.rolcreaterole,row.rolreplication,row.rolbypassrls].some(Boolean))throw Error("The caller must supply a restricted local PG55568 role");
 const schema=process.env.GUILD_NEXT_TEST_SCHEMA,exists=(await pool.query("SELECT 1 FROM pg_namespace WHERE nspname=$1",[schema])).rowCount===1;
 if(process.env.GUILD_QUAL_EXPECT_SCHEMA==="absent"?exists:!exists||row.schema!==schema)throw Error("The original generated schema is not in the required fresh/retained state");
 const expected=JSON.parse(process.env.GUILD_QUAL_EXPECTED_SESSIONS||"[]");
 if(expected.length){
  const sessions=(await pool.query("SELECT id,tenant_id,role,expires_at FROM guild_sessions WHERE id=ANY($1::uuid[])",[expected.map(x=>x.id)])).rows;
  const tenants=(await pool.query("SELECT id,expires_at FROM guild_tenants WHERE id=ANY($1::uuid[])",[expected.map(x=>x.tenantId)])).rows;
  for(const actor of expected){const session=sessions.find(x=>x.id===actor.id),tenant=tenants.find(x=>x.id===actor.tenantId);if(!session||session.tenant_id!==actor.tenantId||session.role!==actor.role||session.expires_at.toISOString()!==actor.expiresAt||!tenant||tenant.expires_at.toISOString()!==actor.expiresAt)throw Error("An original fixture identity or absolute expiry changed");}
 }
 await pool.query("COMMIT");console.log(JSON.stringify({restricted:true,port:row.port,schemaExists:exists,originalSessionsChecked:expected.length,readOnly:true}));
}finally{await pool.end()}
'''


class Qualification:
    def __init__(self, args):
        self.args = args
        self.evidence = pathlib.Path(args.evidence_dir).expanduser().absolute()
        require(not self.evidence.is_symlink(), "The evidence directory cannot be a link.")
        if not self.evidence.exists():
            require(args.mode == "freeze", "Initialize a new explicit evidence directory with freeze first.")
            self.evidence.mkdir(mode=0o700, parents=True)
        self.evidence = self.evidence.resolve()
        require(not within(self.evidence, ROOT), "Private evidence must be outside this checkout.")
        info = self.evidence.stat()
        require(info.st_uid == os.getuid() and info.st_mode & 0o077 == 0, "The evidence directory must be private and owned by this user (0700).")
        url = urllib.parse.urlsplit(args.origin)
        require(url.scheme == "http" and url.hostname == "127.0.0.1" and not (url.username or url.password or url.query or url.fragment) and url.path in ("", "/"), "Use an explicit owned http://127.0.0.1:port origin.")
        require(url.port is not None and 1024 <= url.port <= 65535 and url.port != 55568, "Use a nonprivileged application port distinct from PG55568.")
        self.port, self.origin = url.port, "http://127.0.0.1:" + str(url.port)
        self.node = str(pathlib.Path(args.node or tool("node")).expanduser().resolve())
        require(pathlib.Path(self.node).is_file(), "The selected Node executable is missing.")
        version = subprocess.run([self.node, "--version"], env=system_env(self.node), text=True, capture_output=True, check=True).stdout.strip()
        require(version.startswith("v22."), "This project's package engines require Node22.x.")
        self.node_identity = {"path": self.node, "version": version, "sha256": sha(pathlib.Path(self.node))}
        self.lock = os.open(self.evidence / ".launcher.lock", os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused("Another launcher operation already owns this evidence directory.") from None
        self.meta = None
        if args.mode != "freeze":
            self.meta = read_json(self.evidence / "fixture-meta.json")
            initial = read_json(self.evidence / "fixture-initial-v1.json")
            require({key: value for key, value in self.meta.items() if key != "sourceFreeze"} == {key: value for key, value in initial.items() if key != "sourceFreeze"}, "Original fixture/schema/auth/runtime settings changed.")
            require(re.fullmatch(r"guild_market_next_worker_[a-f0-9]{20}", self.meta["schema"]) and re.fullmatch(r"next-source-freeze-v[1-9][0-9]*\.json", self.meta["sourceFreeze"]), "Invalid original fixture/schema/freeze identity.")
            require(self.meta["root"] == str(ROOT) and self.meta["origin"] == self.origin and self.meta["node"] == self.node_identity, "Project, origin or Node identity differs from this original fixture.")
        supplied = sorted({str(pathlib.Path(value).expanduser().resolve(strict=True)) for value in args.protected_root})
        self.protected = supplied or (self.meta["protectedRoots"] if self.meta else [])
        require(self.protected and all(pathlib.Path(value).is_dir() for value in self.protected), "Supply at least one explicit protected workspace root on freeze.")
        if self.meta:
            require(self.protected == self.meta["protectedRoots"], "The original protected workspace boundary cannot change.")
        self.database = None

    def no_unknown_children(self):
        for path in self.evidence.glob("*-before.json"):
            if path.name.endswith("-sources-before.json"):
                continue
            operation = read_json(path)
            if "mode" not in operation:
                continue
            after = self.evidence / path.name.replace("-before.json", "-after.json")
            require(after.exists() and read_json(after).get("exitCode") is not None,
                    "A prior child has an unknown outcome; inspect its exact private PID/log before any further mutating operation.")
        for intent in self.evidence.glob("runtime-*-intent.json"):
            require((self.evidence / intent.name.replace("-intent.json", "-started.json")).exists(),
                    "An interrupted runtime launch intent has no parent PID record; retain its guard/PID evidence and inspect it manually.")

    def emit(self, **value):
        print(json.dumps(value), flush=True)

    def absent(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                probe.bind(("127.0.0.1", self.port))
            except OSError:
                raise Refused("The selected application port is occupied; no collision will be stopped or replaced.") from None

    def no_runtime(self):
        require(not (self.evidence / "runtime-owner.json").exists(), "An owned/unknown runtime record exists; inspect status and explicitly stop-owned first.")
        self.absent()

    def snapshot(self, name):
        no_environment_files()
        rows = source_inputs()
        value = {"version": "guild.market-next-source-freeze.v1", "at": now(), "root": str(ROOT), "origin": self.origin,
                 "fixtureId": self.meta["fixtureId"] if self.meta else None, "inputs": rows, "fingerprint": digest(rows)}
        write_new(self.evidence / name, value)
        return value

    def frozen(self):
        original = read_json(self.evidence / self.meta["sourceFreeze"])
        require(original["root"] == str(ROOT) and original["origin"] == self.origin, "The source freeze belongs to another checkout or origin.")
        require(source_inputs() == original["inputs"], "Source/scripts/tests changed; review them and explicitly refreeze before another operation.")
        return original

    def freeze(self):
        self.no_runtime()
        require(not (ROOT / ".next").exists(), "A clean initial freeze refuses any pre-existing or copied .next build.")
        require(not any(path.name != ".launcher.lock" for path in self.evidence.iterdir()), "Freeze requires a new empty evidence directory; no fixture is overwritten.")
        fixture_id = secrets.token_hex(16)
        self.meta = {"version": "guild.market-next-fixture-meta.v1", "fixtureId": fixture_id, "schema": "guild_market_next_worker_" + secrets.token_hex(10),
                     "root": str(ROOT), "origin": self.origin, "node": self.node_identity, "protectedRoots": self.protected,
                     "createdAt": now(), "sourceFreeze": "next-source-freeze-v1.json"}
        write_new(self.evidence / "fixture-auth.json", {"authSecret": secrets.token_hex(32), "sessionSecret": secrets.token_hex(32)})
        self.meta["authFileSha256"] = sha(self.evidence / "fixture-auth.json")
        self.snapshot(self.meta["sourceFreeze"])
        write_new(self.evidence / "fixture-initial-v1.json", self.meta)
        write_new(self.evidence / "fixture-meta.json", self.meta)
        self.emit(mode="freeze", origin=self.origin, schema=self.meta["schema"], evidence=str(self.evidence), credentials="private/generated-once")

    def refreeze(self):
        self.no_runtime()
        number = 1
        while (self.evidence / ("next-source-freeze-v" + str(number) + ".json")).exists():
            number += 1
        previous = self.meta["sourceFreeze"]
        name = "next-source-freeze-v" + str(number) + ".json"
        value = self.snapshot(name)
        write_new(self.evidence / ("refreeze-" + secrets.token_hex(12) + ".json"), {"at": now(), "previous": previous, "next": name, "fingerprint": value["fingerprint"], "fixtureId": self.meta["fixtureId"], "fixtureIdentityChanged": False})
        self.meta["sourceFreeze"] = name
        replace_pointer(self.evidence / "fixture-meta.json", self.meta)
        self.emit(mode="refreeze", freeze=name, sourceFiles=len(value["inputs"]), fixtureIdentityChanged=False)

    def load_database(self):
        require(self.args.database_url_file, "Supply --database-url-file with an explicit private restricted local PG55568 URL.")
        input_path = pathlib.Path(self.args.database_url_file).expanduser().resolve()
        require(not within(input_path, ROOT) and not input_path.name.startswith(".env"), "The database input must be a private non-dotenv file outside this checkout.")
        text = private_file(input_path).read_text().strip()
        if text.startswith("{"):
            text = json.loads(text).get("databaseUrl")
        require(isinstance(text, str), "The private database file must contain a URL or a databaseUrl JSON member.")
        try:
            parsed = urllib.parse.urlsplit(text)
            query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True, strict_parsing=True)
            require(parsed.scheme in ("postgres", "postgresql") and parsed.username and parsed.path.startswith("/") and len(parsed.path) > 1 and not parsed.fragment, "Invalid restricted local database URL.")
            require(not any(key not in ("host", "port", "sslmode", "connect_timeout") or len(value) != 1 for key, value in query.items()), "Database URLs cannot supply a schema/options, service files, alternate endpoints or arbitrary connection settings.")
            port = int(query.get("port", [parsed.port or 5432])[0])
            require(port == 55568 and (parsed.port is None or parsed.port == port), "Only caller-supplied local PG55568 is allowed.")
            require(query.get("sslmode", ["disable"])[0] == "disable", "This controlled local qualification requires sslmode=disable.")
            host = query.get("host", [parsed.hostname or ""])[0]
            if host.startswith("/"):
                directory = pathlib.Path(host).resolve(strict=True)
                require(directory.is_dir(), "The explicit PostgreSQL socket directory is missing.")
                host = str(directory)
                endpoint = {"kind": "unix", "path": str(directory / ".s.PGSQL.55568")}
            else:
                require(host in ("127.0.0.1", "::1") and parsed.hostname in ("127.0.0.1", "::1", "localhost"), "Use an exact local IP or absolute Unix socket directory, not a remote/DNS database host.")
                endpoint = {"kind": "tcp", "host": host, "port": 55568}
            query["host"], query["port"], query["sslmode"] = [host], ["55568"], ["disable"]
            base = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(sorted(query.items()), doseq=True), ""))
            query["options"] = ["-c search_path=" + self.meta["schema"]]
            url = urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(sorted(query.items()), doseq=True), ""))
        except Refused:
            raise
        except (ValueError, TypeError):
            raise Refused("Invalid restricted local database URL.") from None
        binding = {"version": "guild.market-next-database-binding.v1", "baseUrlSha256": hashlib.sha256(base.encode()).hexdigest(), "schema": self.meta["schema"], "endpoint": endpoint}
        stored = self.evidence / "database-binding.json"
        if stored.exists():
            require(read_json(stored) == binding, "Database endpoint/credentials differ from the original fixture binding.")
        else:
            require(self.args.mode == "prepare", "Prepare must bind the explicit database before starting or testing.")
            write_new(stored, binding)
        self.database = {"url": url, "endpoint": endpoint}

    def identity(self, required=True):
        record_path = self.evidence / "fixture-identity-v1.json"
        if not record_path.exists():
            require(not required, "A successfully prepared original fixture is required.")
            return None
        record = read_json(record_path)
        require(record["fixtureId"] == self.meta["fixtureId"] and record["fixtureFileSha256"] == sha(private_file(self.evidence / "fixture-private.json")), "The original fixture export/identity changed.")
        require(record["authFileSha256"] == self.meta["authFileSha256"] == sha(private_file(self.evidence / "fixture-auth.json")), "Original fixture authentication changed.")
        for actor in record["sessions"]:
            require(dt.datetime.fromisoformat(actor["expiresAt"].replace("Z", "+00:00")) > dt.datetime.now(dt.timezone.utc), "An original fixture deadline expired; it will not be extended or reseeded.")
        return record

    def environment(self, mode, operation, credentials=False, runtime_id=None):
        (self.evidence / "tmp").mkdir(mode=0o700, exist_ok=True)
        env = {**system_env(self.node), **{key: "" for key in EMPTY_KEYS}, "TMPDIR": str(self.evidence / "tmp"),
               "GUILD_NEXT_TEST_SCHEMA": self.meta["schema"], "GUILD_NEXT_EVIDENCE_DIR": str(self.evidence), "GUILD_NEXT_HTTP_ORIGIN": self.origin,
               "GUILD_MARKET_APP_URL": self.origin, "APP_URL": self.origin, "GUILD_QUAL_PROJECT_ROOT": str(ROOT),
               "GUILD_QUAL_PROTECTED_ROOTS": json.dumps(self.protected), "GUILD_QUAL_MODE": mode, "GUILD_QUAL_OPERATION_ID": operation,
               "NODE_OPTIONS": "--import=" + GUARD.as_uri()}
        if credentials:
            require(self.database is not None, "An explicit restricted database is required.")
            require(sha(private_file(self.evidence / "fixture-auth.json")) == self.meta["authFileSha256"], "The original auth file changed.")
            auth = read_json(self.evidence / "fixture-auth.json")
            env.update(DATABASE_URL=self.database["url"], AUTH_SECRET=auth["authSecret"], JUDGE_SESSION_SECRET=auth["sessionSecret"],
                       GUILD_QUAL_DATABASE_ENDPOINT=json.dumps(self.database["endpoint"]))
        if runtime_id:
            env["GUILD_QUAL_RUNTIME_ID"] = runtime_id
        return env

    def preflight(self, operation, absent=False):
        identity = self.identity(required=not absent)
        env = self.environment("database-preflight", operation, True)
        env["GUILD_QUAL_EXPECT_SCHEMA"] = "absent" if absent else "present"
        env["GUILD_QUAL_EXPECTED_SESSIONS"] = json.dumps(identity["sessions"] if identity else [])
        log = self.evidence / ("preflight-" + operation + ".log")
        with os.fdopen(os.open(log, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
            result = subprocess.run([self.node, "--input-type=module", "-e", PREFLIGHT], cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT)
        require(result.returncode == 0, "The read-only restricted database/identity preflight failed; inspect its private log.")

    def process_identity(self, pid):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return None
        state = system_output([tool("ps"), "-p", str(pid), "-o", "stat="], False)
        if state.returncode != 0 or state.stdout.strip().startswith("Z"):
            return None
        started = system_output([tool("ps"), "-p", str(pid), "-o", "lstart="]).stdout.strip()
        command = system_output([tool("ps"), "-ww", "-p", str(pid), "-o", "command="]).stdout.strip()
        if sys.platform.startswith("linux"):
            proc = pathlib.Path("/proc") / str(pid)
            cwd = str((proc / "cwd").resolve(strict=True))
            executable = str((proc / "exe").resolve(strict=True))
            raw = (proc / "stat").read_text(); ticks = raw[raw.rfind(")") + 2:].split()[19]
        else:
            names = system_output([tool("lsof"), "-a", "-p", str(pid), "-d", "cwd", "-Fn"]).stdout.splitlines()
            directories = [line[1:] for line in names if line.startswith("n")]
            require(len(directories) == 1, "Cannot verify the exact runtime cwd.")
            cwd = str(pathlib.Path(directories[0]).resolve())
            texts = system_output([tool("lsof"), "-a", "-p", str(pid), "-d", "txt", "-Fn"]).stdout.splitlines()
            require(any(line.startswith("n") and pathlib.Path(line[1:]).resolve() == pathlib.Path(self.node) for line in texts), "Cannot verify the exact runtime executable.")
            executable, ticks = self.node, None
        require(started and command, "Cannot verify the exact runtime process identity.")
        return {"started": started, "startTicks": ticks, "command": command, "cwd": cwd, "executable": executable}

    def listeners(self):
        result = system_output([tool("lsof"), "-nP", "-t", "-iTCP:" + str(self.port), "-sTCP:LISTEN"], False)
        require(result.returncode in (0, 1), "Cannot inspect listener ownership.")
        return sorted(set(int(value) for value in result.stdout.split()))

    def verify_build(self, require_current_sources=True):
        build = read_json(self.evidence / "build-current.json")
        require(build["passed"] and build["fixtureId"] == self.meta["fixtureId"], "A successful build owned by this fixture is required.")
        if require_current_sources:
            require(digest(source_inputs()) == build["sourceFingerprint"], "Current source differs from the clean build, even if it was refrozen.")
        require(sha(ROOT / ".next/BUILD_ID") == build["buildIdHash"] and digest(build_inputs()) == build["buildFingerprint"], "The owned compiled build changed.")
        return build

    def verify_runtime(self, stopping=False):
        record = read_json(self.evidence / "runtime-owner.json")
        require(record["state"] in (("starting", "listening") if stopping else ("listening",)) and record["cwd"] == str(ROOT) and record["origin"] == self.origin and record["fixtureId"] == self.meta["fixtureId"], "The runtime record is not this exact ready fixture.")
        current = self.process_identity(record["pid"])
        if stopping and record["state"] == "starting":
            initial = record.get("initialProcessIdentity")
            require(current and initial and all(current[key] == initial[key] for key in ("started", "startTicks", "cwd", "executable")) and "next" in current["command"].lower(), "The exact starting PID cannot be verified.")
        else:
            require(current == record["processIdentity"], "Runtime PID/start/cwd/executable identity changed.")
        owners = self.listeners()
        require(owners == [record["pid"]] or stopping and not owners, "The listener belongs to another process; it will not be stopped.")
        build = self.verify_build(require_current_sources=not stopping)
        require(record["buildIdHash"] == build["buildIdHash"] and (stopping or record["guardSha256"] == sha(GUARD)), "Runtime build/guard identity changed.")
        guard = read_json(self.evidence / record["guardOwnerRecord"])
        require(guard["pid"] == record["pid"] and guard["runtimeIdHash"] == record["runtimeIdHash"] and guard["cwd"] == str(ROOT) and guard["guardSha256"] == record["guardSha256"], "The original guard ownership record does not match.")
        return record

    def child(self, mode, argv, credentials=False):
        self.frozen()
        operation = secrets.token_hex(12)
        before = self.snapshot(mode + "-" + operation + "-sources-before.json")
        log = self.evidence / (mode + "-" + operation + ".log")
        write_new(self.evidence / (mode + "-" + operation + "-before.json"), {"at": now(), "mode": mode, "argv": argv, "fixtureId": self.meta["fixtureId"], "sourceFingerprint": before["fingerprint"], "log": log.name})
        self.emit(mode=mode, origin=self.origin, schema=self.meta["schema"], log=str(log), automaticRetries=False)
        code = None
        try:
            with os.fdopen(os.open(log, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
                child = subprocess.Popen(argv, cwd=ROOT, env=self.environment(mode, operation, credentials), stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
                write_new(self.evidence / (mode + "-" + operation + "-child.json"), {"pid": child.pid, "at": now(), "fixtureId": self.meta["fixtureId"], "cwd": str(ROOT)})
                code = child.wait()
        finally:
            after = self.snapshot(mode + "-" + operation + "-sources-after.json")
            changed = source_changes(before["inputs"], after["inputs"])
            passed = code == 0 and not [name for name in changed if mode != "build" or name != "next-env.d.ts"]
            write_new(self.evidence / (mode + "-" + operation + "-after.json"), {"at": now(), "exitCode": code, "outcome": "unknown" if code is None else "observed", "passed": passed, "changedSources": changed, "sourceFingerprint": after["fingerprint"]})
        return operation, code, passed, after

    def build(self):
        self.no_runtime()
        require(not (ROOT / ".next").exists(), "A build is already present; only an explicit verified archive-build can retire an owned build.")
        operation, code, passed, after = self.child("build", [self.node, str(ROOT / "node_modules/next/dist/bin/next"), "build"])
        rows = build_inputs() if (ROOT / ".next").is_dir() else []
        build_id = ROOT / ".next/BUILD_ID"
        record = {"version": "guild.market-next-owned-build.v1", "at": now(), "fixtureId": self.meta["fixtureId"], "operation": operation, "root": str(ROOT),
                  "passed": passed and build_id.is_file(), "sourceFingerprint": after["fingerprint"], "buildIdHash": sha(build_id) if build_id.is_file() else None,
                  "buildFingerprint": digest(rows), "inputs": rows, "exitCode": code}
        write_new(self.evidence / ("build-" + operation + "-owned.json"), record)
        replace_pointer(self.evidence / "build-current.json", record)
        require(record["passed"], "The clean build failed or source drifted; its private log and output are retained.")
        self.emit(mode="build", passed=True, generatedNextEnvIncluded=True, next="refreeze, then typecheck/prepare/start")

    def archive_build(self):
        self.no_runtime()
        record = read_json(self.evidence / "build-current.json")
        require(record["fixtureId"] == self.meta["fixtureId"] and digest(build_inputs()) == record["buildFingerprint"], "Only this exact known owned build can be archived; unknown/copied builds are refused.")
        destination = self.evidence / ("retired-build-" + secrets.token_hex(12))
        # No cross-device copy fallback: this must retire the owned directory.
        (ROOT / ".next").rename(destination)
        pointer = self.evidence / "build-current.json"
        pointer.rename(self.evidence / ("build-pointer-retired-" + secrets.token_hex(12) + ".json"))
        self.emit(mode="archive-build", archived=str(destination), fixtureIdentityChanged=False)

    def prepare(self):
        self.no_runtime()
        self.frozen()
        require(not (self.evidence / "prepare-claim.json").exists() and not (self.evidence / "fixture-private.json").exists(), "This fixture was already prepared or has an unknown prepare outcome; it will not be reseeded.")
        self.load_database()
        self.preflight(secrets.token_hex(12), absent=True)
        write_new(self.evidence / "prepare-claim.json", {"at": now(), "fixtureId": self.meta["fixtureId"], "schema": self.meta["schema"], "outcomeIfInterrupted": "unknown; never reseed"})
        _, _, passed, _ = self.child("prepare", [self.node, "--import", "tsx", "scripts/check-provider-market-next-http.ts", "prepare"], True)
        require(passed, "Fixture preparation did not complete cleanly; retain its unknown outcome and do not reseed.")
        fixture_path = private_file(self.evidence / "fixture-private.json")
        fixture = read_json(fixture_path)
        require(fixture["schema"] == self.meta["schema"] and fixture["origin"] == self.origin, "Prepared fixture does not match the original schema/origin.")
        actors = [fixture["buyer"], fixture["foreign"], *fixture["providers"].values()]
        record = {"version": "guild.market-next-original-identities.v1", "at": now(), "fixtureId": self.meta["fixtureId"], "fixtureFileSha256": sha(fixture_path),
                  "authFileSha256": self.meta["authFileSha256"], "sessions": [actor["session"] for actor in actors], "commissions": fixture["commissions"]}
        write_new(self.evidence / "fixture-identity-v1.json", record)
        self.preflight(secrets.token_hex(12))
        self.emit(mode="prepare", passed=True, originalSessions=len(actors), schema=self.meta["schema"], fixtureExports="private only")

    def start(self):
        self.no_runtime(); self.frozen(); self.identity(); self.load_database()
        self.preflight(secrets.token_hex(12))
        build = self.verify_build()
        operation, runtime_id = secrets.token_hex(12), secrets.token_hex(32)
        self.snapshot("start-" + operation + "-sources-before.json")
        argv = [self.node, str(ROOT / "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", str(self.port)]
        log = self.evidence / ("start-" + operation + ".log")
        write_new(self.evidence / ("runtime-" + operation + "-intent.json"), {"at": now(), "fixtureId": self.meta["fixtureId"], "argv": argv, "runtimeIdHash": hashlib.sha256(runtime_id.encode()).hexdigest(), "guardOwnerPattern": "runtime-guard-" + operation + "-<pid>.json", "outcomeIfInterrupted": "unknown; retain original operation"})
        with os.fdopen(os.open(log, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
            child = subprocess.Popen(argv, cwd=ROOT, env=self.environment("start", operation, True, runtime_id), stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
        record = {"version": "guild.market-next-runtime-owner.v1", "state": "starting", "pid": child.pid, "processGroup": child.pid, "port": self.port,
                  "origin": self.origin, "schema": self.meta["schema"], "fixtureId": self.meta["fixtureId"], "cwd": str(ROOT), "startedAt": now(), "argv": argv,
                  "guard": str(GUARD), "guardSha256": sha(GUARD), "buildIdHash": build["buildIdHash"], "buildFingerprint": build["buildFingerprint"],
                  "runtimeIdHash": hashlib.sha256(runtime_id.encode()).hexdigest(), "guardOwnerRecord": "runtime-guard-" + operation + "-" + str(child.pid) + ".json", "log": str(log),
                  "initialProcessIdentity": self.process_identity(child.pid)}
        write_new(self.evidence / ("runtime-" + operation + "-started.json"), record)
        write_new(self.evidence / "runtime-owner.json", record)
        self.emit(mode="start", state="starting", pid=child.pid, origin=self.origin, log=str(log))
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            require(child.poll() is None, "The owned runtime exited during startup; its exact record and log are retained.")
            owners = self.listeners()
            require(not owners or owners == [child.pid], "A startup collision belongs to another PID; it will not be stopped.")
            if owners == [child.pid] and (self.evidence / record["guardOwnerRecord"]).is_file():
                break
            time.sleep(0.1)
        else:
            raise Refused("Startup outcome is unknown after30s; retain the PID/log and inspect status or explicitly stop-owned. No retry was started.")
        identity = self.process_identity(child.pid)
        require(identity and identity["cwd"] == str(ROOT) and identity["executable"] == self.node and "next" in identity["command"].lower(), "The started PID is not the exact owned Next runtime.")
        record.update(state="listening", processIdentity=identity)
        write_new(self.evidence / ("runtime-" + operation + "-ready.json"), record)
        replace_pointer(self.evidence / "runtime-owner.json", record)
        self.snapshot("start-" + operation + "-sources-after.json")
        self.verify_runtime()
        self.emit(mode="start", state="listening", pid=child.pid, origin=self.origin, ownerRecord=str(self.evidence / "runtime-owner.json"))

    def qualify(self):
        self.frozen(); self.identity(); self.load_database(); self.verify_runtime()
        self.preflight(secrets.token_hex(12))
        claim = self.evidence / "qualification-claim.json"
        require(not claim.exists(), "This fixture already has a test/check attempt or unknown outcome; replaying the mutating suite is refused.")
        write_new(claim, {"at": now(), "fixtureId": self.meta["fixtureId"], "mode": self.args.mode, "automaticRetry": False})
        argv = [self.node, "--import", "tsx"] + (["--test", "tests/provider-market-next-http.test.ts"] if self.args.mode == "test" else ["scripts/check-provider-market-next-http.ts"])
        _, _, passed, _ = self.child(self.args.mode, argv, True)
        self.identity(); self.verify_runtime(); self.preflight(secrets.token_hex(12))
        require(passed, "Qualification failed; reports/unknown outcomes are retained and this fixture is not reset.")
        self.emit(mode=self.args.mode, passed=True, nativeBrowser=False, controlledProviders=True, reports="private evidence directory")

    def status(self):
        record_path = self.evidence / "runtime-owner.json"
        if not record_path.exists():
            self.emit(mode="status", ownedRuntime=False, listenerPids=self.listeners())
            return
        record = read_json(record_path)
        self.emit(mode="status", state=record["state"], pid=record["pid"], origin=self.origin,
                  processAlive=self.process_identity(record["pid"]) is not None, listenerPids=self.listeners(), recordsUnchanged=True)

    def stop(self):
        record = read_json(self.evidence / "runtime-owner.json")
        require(record["cwd"] == str(ROOT) and record["origin"] == self.origin and record["fixtureId"] == self.meta["fixtureId"], "This is not the exact owned runtime.")
        identity = self.process_identity(record["pid"])
        if identity is None:
            require(not self.listeners(), "The port has a collision; no PID will be stopped or replaced.")
            outcome = "observed-exited; no signal sent"
        else:
            self.verify_runtime(stopping=True)
            os.kill(record["pid"], signal.SIGTERM)  # Never signal a process group or a collision.
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and self.process_identity(record["pid"]) is not None:
                time.sleep(0.1)
            require(self.process_identity(record["pid"]) is None and not self.listeners(), "Stop outcome is unknown; the original record is retained. No SIGKILL/retry was sent.")
            outcome = "verified PID terminated"
        operation = secrets.token_hex(12)
        write_new(self.evidence / ("runtime-stop-" + operation + ".json"), {"at": now(), "pid": record["pid"], "outcome": outcome, "originalOwnerSha256": sha(self.evidence / "runtime-owner.json")})
        (self.evidence / "runtime-owner.json").rename(self.evidence / ("runtime-owner-stopped-" + operation + ".json"))
        self.emit(mode="stop-owned", pid=record["pid"], outcome=outcome, port=self.port)

    def run(self):
        mode = self.args.mode
        if mode not in ("freeze", "status", "stop-owned", "typecheck"):
            self.no_unknown_children()
        if mode not in ("prepare", "start", "test", "check"):
            require(not self.args.database_url_file, "Build/typecheck/freeze/status/stop do not load database credentials; omit --database-url-file.")
        if mode == "freeze": self.freeze()
        elif mode == "refreeze": self.refreeze()
        elif mode == "build": self.build()
        elif mode == "archive-build": self.archive_build()
        elif mode == "typecheck":
            if (self.evidence / "runtime-owner.json").exists():
                self.verify_runtime()
            _, _, passed, _ = self.child("typecheck", [self.node, "node_modules/typescript/bin/tsc", "--noEmit", "--incremental", "false"])
            require(passed, "Typecheck failed or changed source; inspect its retained private log.")
            self.emit(mode=mode, passed=True, databaseCredentialsLoaded=False)
        elif mode == "prepare": self.prepare()
        elif mode == "start": self.start()
        elif mode in ("test", "check"): self.qualify()
        elif mode == "status": self.status()
        elif mode == "stop-owned": self.stop()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=MODES)
    parser.add_argument("--evidence-dir", required=True, help="Explicit private0700 directory outside the checkout; freeze requires it empty")
    parser.add_argument("--origin", required=True, help="Explicit owned http://127.0.0.1:port, for example4590")
    parser.add_argument("--protected-root", action="append", default=[], help="Workspace containing original checkouts/evidence; required on freeze and pinned thereafter")
    parser.add_argument("--database-url-file", help="Private0600 URL file or JSON databaseUrl input, only for prepare/start/test/check")
    parser.add_argument("--node", help="Node22 executable; otherwise resolved from PATH and pinned")
    args = parser.parse_args()
    require(os.name == "posix", "This ownership launcher requires POSIX Python, git, ps and lsof.")
    os.umask(0o077)
    qualification = Qualification(args)
    try:
        qualification.run()
    finally:
        os.close(qualification.lock)


if __name__ == "__main__":
    try:
        main()
    except (Refused, OSError, ValueError, subprocess.CalledProcessError, KeyError) as error:
        # Never echo connection strings, auth fields, cookies or command output.
        message = str(error) if isinstance(error, Refused) else "Qualification did not complete. Retain private evidence and inspect the original input/operation; no automatic retry occurred."
        print(json.dumps({"passed": False, "error": message, "automaticRetries": False}), file=sys.stderr)
        raise SystemExit(1)
