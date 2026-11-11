import { open, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sha } from './identity.mjs';

const maximumFileBytes = 16 * 1024 * 1024, maximumCaseBytes = 64 * 1024 * 1024, maximumFiles = 200;
const reportPath = /^[a-z][a-z0-9-]{0,150}\.json$/, hash = /^[a-f0-9]{64}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).sort().join() === [...keys].sort().join();
const decode = bytes => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
export function validEvidenceFile(value) {
  return exactKeys(value, ['path', 'byteLength', 'contentHash']) && typeof value.path === 'string' && reportPath.test(value.path)
    && typeof value.contentHash === 'string' && hash.test(value.contentHash) && Number.isSafeInteger(value.byteLength) && value.byteLength > 0 && value.byteLength <= maximumFileBytes;
}

/** Every complete report is byte-exact. An over-limit report leaves an explicit
 * non-passing retention receipt, never a truncated report counted as complete. */
export function evidenceWriter(directory, maximumBytes = maximumCaseBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 8192 || maximumBytes > maximumCaseBytes) throw new Error('Invalid bounded audit retention capacity.');
  const files = []; let total = 0;
  const reservedFailureBytes = 4096;
  function entry(path, value) { return { path, byteLength: value.length, contentHash: sha(value) }; }
  async function bytes(path, value) {
    if (!validEvidenceFile(entry(path, value)) || total + value.length > maximumBytes || files.length >= maximumFiles || files.some(file => file.path === path)) throw new Error('Audit evidence does not fit its exact file contract.');
    const handle = await open(resolve(directory, path), 'wx', 0o600);
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
    const file = entry(path, value); files.push(file); total += value.length;
    return file;
  }
  async function json(path, value) {
    if (!reportPath.test(path) || files.some(file => file.path === path)) throw new Error('Invalid or repeated audit report path.');
    const raw = Buffer.from(JSON.stringify(value)), rawHash = sha(raw), planned = [];
    if (raw.length <= 1024 * 1024) planned.push({ path, value: raw });
    else {
      const parts = [], count = Math.ceil(raw.length / (512 * 1024));
      // Preflight the entire encoded report, including index/chunk overhead,
      // before any part is written. The limit never strands an incomplete index.
      if (count < maximumFiles) for (let index = 0; index < count; index++) {
        const partPath = path.replace(/\.json$/, '-part-' + String(index + 1).padStart(3, '0') + '.json');
        const part = Buffer.from(JSON.stringify({ version: 'guild.audit-raw-chunk.v1', originalPath: path, index, count, rawHash, dataBase64: raw.subarray(index * 512 * 1024, (index + 1) * 512 * 1024).toString('base64') }));
        planned.push({ path: partPath, value: part }); parts.push(entry(partPath, part));
      }
      planned.push({ path, value: Buffer.from(JSON.stringify({ version: 'guild.audit-raw-index.v1', rawHash, byteLength: raw.length, parts })) });
    }
    const encodedBytes = planned.reduce((sum, file) => sum + file.value.length, 0);
    const fits = raw.length <= maximumCaseBytes && Math.ceil(raw.length / (512 * 1024)) < maximumFiles
      && encodedBytes <= maximumBytes - total - reservedFailureBytes && planned.length + files.length < maximumFiles
      && planned.every(file => validEvidenceFile(entry(file.path, file.value)) && !files.some(existing => existing.path === file.path));
    if (!fits) {
      const marker = { version: 'guild.audit-retention-failure.v1', originalPath: path, originalByteLength: raw.length, originalHash: rawHash,
        originalReportRetained: false, complete: false, reason: 'The complete original report exceeds the fixed byte/file retention capacity. Its findings have not been retained or counted as a passing measurement.',
        maximumCaseBytes: maximumBytes, maximumFiles, alreadyRetainedBytes: total, alreadyRetainedFiles: files.length };
      await bytes(path.replace(/\.json$/, '-retention-failure.json'), Buffer.from(JSON.stringify(marker)));
      throw new Error('AUDIT_EVIDENCE_LIMIT: ' + path + ' (' + raw.length + ' original bytes) could not be retained completely under the unchanged case limit; this case is incomplete and must not pass.');
    }
    let result;
    for (const file of planned) result = await bytes(file.path, file.value);
    return result;
  }
  return { files, json };
}

export async function readEvidenceJson(directory, file, manifest) {
  if (!Array.isArray(manifest) || !manifest.length || manifest.length > maximumFiles || !manifest.every(validEvidenceFile)
    || new Set(manifest.map(item => item.path)).size !== manifest.length || manifest.reduce((sum, item) => sum + item.byteLength, 0) > maximumCaseBytes) throw new Error('The exact bounded evidence manifest is invalid.');
  const read = async reference => {
    if (!validEvidenceFile(reference) || !manifest.some(item => item.path === reference.path && item.contentHash === reference.contentHash && item.byteLength === reference.byteLength)) throw new Error('An evidence reference leaves its exact saved manifest.');
    const bytes = await readFile(resolve(directory, reference.path));
    if (bytes.length !== reference.byteLength || sha(bytes) !== reference.contentHash) throw new Error('Retained browser evidence bytes changed.');
    return bytes;
  };
  const data = decode(await read(file));
  if (!object(data)) throw new Error('A retained native report must be a JSON object.');
  if (data.version !== 'guild.audit-raw-index.v1') return data;
  if (!exactKeys(data, ['version', 'rawHash', 'byteLength', 'parts']) || !hash.test(data.rawHash) || !Number.isSafeInteger(data.byteLength) || data.byteLength <= 1024 * 1024 || data.byteLength > maximumCaseBytes
    || !Array.isArray(data.parts) || !data.parts.length || data.parts.length >= maximumFiles || new Set(data.parts.map(part => part.path)).size !== data.parts.length) throw new Error('The native report index has invalid bounds or repeated parts.');
  const chunks = [];
  for (const [index, part] of data.parts.entries()) {
    const chunk = decode(await read(part));
    if (!exactKeys(chunk, ['version', 'originalPath', 'index', 'count', 'rawHash', 'dataBase64']) || chunk.version !== 'guild.audit-raw-chunk.v1' || chunk.index !== index || chunk.count !== data.parts.length || chunk.rawHash !== data.rawHash || chunk.originalPath !== file.path || typeof chunk.dataBase64 !== 'string') throw new Error('A retained native report has a missing or reordered byte chunk.');
    const bytes = Buffer.from(chunk.dataBase64, 'base64');
    if (bytes.toString('base64') !== chunk.dataBase64 || !bytes.length || bytes.length > 512 * 1024 || index < data.parts.length - 1 && bytes.length !== 512 * 1024) throw new Error('A native report chunk has noncanonical bytes or boundaries.');
    chunks.push(bytes);
  }
  const original = Buffer.concat(chunks);
  if (original.length !== data.byteLength || sha(original) !== data.rawHash) throw new Error('The complete native report hash changed.');
  const result = decode(original);
  if (!object(result)) throw new Error('The original native report must be a JSON object.');
  return result;
}
