// Disposable source-test guard. Tests opt into their explicit synthetic fetch
// transports. The PostgreSQL connection uses a private local Unix socket.
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
const denied = () => { throw new Error('Unstubbed network denied in hosted source tests'); };
globalThis.fetch = async () => denied();
http.request = denied; http.get = denied; https.request = denied; https.get = denied;
syncBuiltinESMExports();
process.loadEnvFile = () => { throw new Error('Environment-file loading disabled in disposable hosted source tests'); };
