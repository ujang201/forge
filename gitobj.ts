// Git object model: SHA-1, loose object encode/decode, tree/commit parse and
// serialize, packfile parse and generate (undeltified output, delta input).
// Node 22 standard library only: node:crypto (sha1), node:zlib (deflate/inflate).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const OID_RE = /^[0-9a-f]{40}$/;

export function isOid(s: string): boolean {
  return OID_RE.test(s);
}

/** SHA-1 hex of the git object header + payload. */
export function hashObject(type: string, payload: Buffer): string {
  const header = Buffer.from(`${type} ${payload.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(payload).digest('hex');
}

/** The full stored form of an object: "<type> <len>\0<payload>". */
export function fullObject(type: string, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${payload.length}\0`, 'ascii'), payload]);
}

/** Parse a full object buffer into {type, payload}. */
export function parseObject(buf: Buffer): { type: string; payload: Buffer } {
  const nul = buf.indexOf(0);
  const header = buf.subarray(0, nul).toString('ascii');
  const [type] = header.split(' ');
  return { type, payload: buf.subarray(nul + 1) };
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // e.g. "100644", "40000" (dirs are stored without leading zero)
  name: string;
  oid: string;
}

/** Serialize tree entries in git's canonical order (name sort, dirs as name+"/"). */
export function serializeTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree payload into entries. */
export function parseTree(payload: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < payload.length) {
    const sp = payload.indexOf(0x20, off);
    const nul = payload.indexOf(0, sp);
    const mode = payload.subarray(off, sp).toString('ascii');
    const name = payload.subarray(sp + 1, nul).toString('utf8');
    const oid = payload.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

// ---------------------------------------------------------------- commits

export interface CommitData {
  tree: string;
  parents: string[];
  author: string; // full "Name <email> ts tz" line
  committer: string;
  message: string;
}

export function serializeCommit(c: CommitData): Buffer {
  const lines: string[] = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.author}`, `committer ${c.committer}`, '', c.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export function parseCommit(payload: Buffer): CommitData {
  const text = payload.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const c: CommitData = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) c.tree = line.slice(5);
    else if (line.startsWith('parent ')) c.parents.push(line.slice(7));
    else if (line.startsWith('author ')) c.author = line.slice(7);
    else if (line.startsWith('committer ')) c.committer = line.slice(10);
  }
  return c;
}

// ---------------------------------------------------------------- packfiles

const OBJ_COMMIT = 1;
const OBJ_TREE = 2;
const OBJ_BLOB = 3;
const OBJ_TAG = 4;
const OBJ_OFS_DELTA = 6;
const OBJ_REF_DELTA = 7;
const TYPE_BY_NUM: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const NUM_BY_TYPE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export interface PackObject {
  type: string;
  payload: Buffer;
  oid: string;
}

/** Apply a git delta (base + delta instructions) -> result payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return v;
  };
  const srcSize = readVarint();
  const dstSize = readVarint();
  if (srcSize !== base.length) throw new Error(`delta base size ${srcSize} != ${base.length}`);
  const out: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) cpOff |= delta[off++] << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) cpSize |= delta[off++] << (8 * i);
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op !== 0) {
      out.push(delta.subarray(off, off + op));
      off += op;
      total += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== dstSize || total !== dstSize) throw new Error('delta result size mismatch');
  return result;
}

/**
 * Parse a packfile. `lookup` resolves base objects the pack itself does not carry
 * (thin packs): (oid) => full object buffer or undefined. Returns objects in pack order.
 * inflateSync ignores trailing bytes and throws on truncation, so each object's
 * compressed length is found by binary search for the smallest end that inflates.
 */
export function parsePack(pack: Buffer, lookup?: (oid: string) => Buffer | undefined): PackObject[] {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const dataEnd = pack.length - 20; // last 20 bytes are the pack trailer checksum
  let off = 12;
  const objects: PackObject[] = [];
  const byOffset = new Map<number, PackObject>();
  const byOid = new Map<string, PackObject>();

  const inflateAt = (start: number, size: number): { data: Buffer; end: number } => {
    // inflateSync ignores trailing bytes and throws on truncation, so the
    // compressed stream's end is the smallest offset that inflates. A deflate
    // stream is never much larger than its output (stored blocks add ~5 bytes
    // per 64 KiB plus the zlib header/trailer), so binary-search a tight
    // window instead of probing from the whole pack: far fewer throws.
    const hiBound = Math.min(dataEnd, start + size + 16 + 5 * (size >> 16));
    let lo = start + 1;
    let hi = hiBound;
    let best: Buffer | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      try {
        best = inflateSync(pack.subarray(start, mid));
        hi = mid - 1;
      } catch {
        lo = mid + 1;
      }
    }
    if (best !== null) return { data: best, end: lo };
    // Fall back to the full remaining pack (should not happen for valid packs).
    return { data: inflateSync(pack.subarray(start, dataEnd)), end: dataEnd };
  };

  for (let i = 0; i < count; i++) {
    const startOff = off;
    const b0 = pack[off++];
    const typeNum = (b0 >> 4) & 0x7;
    let size = b0 & 0x0f;
    let shift = 4;
    let b = b0;
    while (b & 0x80) {
      b = pack[off++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOff: number | undefined;
    if (typeNum === OBJ_REF_DELTA) {
      baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (typeNum === OBJ_OFS_DELTA) {
      let bb = pack[off++];
      let base = bb & 0x7f;
      while (bb & 0x80) {
        bb = pack[off++];
        base = ((base + 1) << 7) | (bb & 0x7f);
      }
      baseOff = startOff - base;
    }
    const { data: inflated, end } = inflateAt(off, size);
    off = end;
    let obj: PackObject;
    if (typeNum === OBJ_OFS_DELTA || typeNum === OBJ_REF_DELTA) {
      let baseObj: PackObject | undefined;
      let baseFull: Buffer | undefined;
      if (baseOff !== undefined) {
        baseObj = byOffset.get(baseOff);
        if (baseObj !== undefined) baseFull = fullObject(baseObj.type, baseObj.payload);
      } else if (baseOid !== undefined) {
        baseObj = byOid.get(baseOid);
        if (baseObj !== undefined) baseFull = fullObject(baseObj.type, baseObj.payload);
        else if (lookup !== undefined) baseFull = lookup(baseOid);
      }
      if (baseFull === undefined) throw new Error(`delta base not found (type ${typeNum})`);
      const baseParsed = parseObject(baseFull);
      const payload = applyDelta(baseParsed.payload, inflated);
      const type = baseParsed.type;
      obj = { type, payload, oid: hashObject(type, payload) };
    } else {
      const type = TYPE_BY_NUM[typeNum];
      if (type === undefined) throw new Error(`unknown pack object type ${typeNum}`);
      if (inflated.length !== size) throw new Error(`object size mismatch: got ${inflated.length}, want ${size}`);
      obj = { type, payload: inflated, oid: hashObject(type, inflated) };
    }
    objects.push(obj);
    byOffset.set(startOff, obj);
    byOid.set(obj.oid, obj);
  }
  return objects;
}

/** Encode one object into pack form (undeltified): size/type header + zlib data. */
function packObjectBytes(type: string, payload: Buffer): Buffer {
  const typeNum = NUM_BY_TYPE[type];
  if (typeNum === undefined) throw new Error(`cannot pack type ${type}`);
  const size = payload.length;
  const header: number[] = [];
  let b = (typeNum << 4) | (size & 0x0f);
  let rest = size >> 4;
  if (rest > 0) b |= 0x80;
  header.push(b);
  while (rest > 0) {
    let bb = rest & 0x7f;
    rest >>= 7;
    if (rest > 0) bb |= 0x80;
    header.push(bb);
  }
  return Buffer.concat([Buffer.from(header), deflateSync(payload)]);
}

/**
 * Generate a packfile (version 2) holding the given objects, undeltified.
 * `objects` are {type, payload}; oids are computed. Returns the pack bytes
 * including the trailing pack SHA-1.
 */
export function generatePack(objects: { type: string; payload: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const o of objects) parts.push(packObjectBytes(o.type, o.payload));
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}
