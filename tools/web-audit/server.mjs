import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { digest, inside, sha } from './identity.mjs';

export async function readExactBundle(directory, bundle) {
  const root = await realpath(directory), values = new Map();
  if (bundle.version !== 'guild.portable-exhibition.v1' || bundle.files.length < 12 || bundle.files.length > 450 || bundle.totalBytes > 128 * 1024 * 1024) throw new Error('Unsupported bundle contract.');
  if (bundle.filesDigest !== digest(bundle.files.map(({ path, mediaType, byteLength, contentHash }) => ({ path, mediaType, byteLength, contentHash })))) throw new Error('The ordered bundle manifest changed.');
  for (const file of bundle.files) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,220}$/.test(file.path) || file.path.split('/').some(part => !part || part === '.' || part === '..') || values.has(file.path)) throw new Error('A bundle path leaves or aliases its registered archive.');
    const path = await realpath(resolve(root, file.path));
    if (!inside(root, path)) throw new Error('A source file leaves the isolated bundle directory.');
    const bytes = await readFile(path);
    if (bytes.length !== file.byteLength || sha(bytes) !== file.contentHash) throw new Error('An actual bundle file differs from its saved bytes: ' + file.path);
    values.set(file.path, { ...file, bytes });
  }
  if ([...values.values()].reduce((sum, item) => sum + item.byteLength, 0) !== bundle.totalBytes) throw new Error('The bundle byte count changed.');
  const record = JSON.parse(values.get('source-record.json').bytes.toString('utf8'));
  if (record.sourceDigest !== bundle.sourceDigest || record.designDigest !== bundle.designDigest || digest(record.sources) !== bundle.sourceDigest || digest(record.design) !== bundle.designDigest) throw new Error('The complete original source/design record changed.');
  return { values, record };
}
export async function bundleServer(values) {
  const prefix = '/' + randomBytes(24).toString('hex') + '/', requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : '';
    const file = values.get(path);
    if (!['GET', 'HEAD'].includes(request.method) || !file) { response.writeHead(404).end(); return; }
    requests.push({ path, method: request.method, range: request.headers.range ?? null });
    const headers = { 'Content-Type': file.mediaType + (file.mediaType.startsWith('text/') || file.mediaType.includes('json') || file.mediaType.includes('javascript') ? '; charset=utf-8' : ''), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', 'Referrer-Policy': 'no-referrer' };
    let start = 0, end = file.bytes.length - 1, status = 200;
    if (request.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range), suffix = range && !range[1] && range[2] ? Number(range[2]) : null;
      start = suffix !== null ? Math.max(0, file.bytes.length - suffix) : Number(range?.[1] ?? NaN);
      end = suffix !== null || !range?.[2] ? file.bytes.length - 1 : Math.min(Number(range[2]), file.bytes.length - 1);
      if (!range || !range[1] && !range[2] || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= file.bytes.length || end < start || suffix !== null && suffix <= 0) { response.writeHead(416, { ...headers, 'Content-Range': `bytes */${file.bytes.length}` }).end(); return; }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${file.bytes.length}`;
    }
    response.writeHead(status, { ...headers, 'Content-Length': String(end - start + 1) });
    response.end(request.method === 'HEAD' ? undefined : file.bytes.subarray(start, end + 1));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  return { origin: `http://127.0.0.1:${address.port}`, url: `http://127.0.0.1:${address.port}${prefix}index.html`, requests,
    close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }) };
}
