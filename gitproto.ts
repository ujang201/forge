// Git smart HTTP: protocol v2 upload-pack (ls-refs, fetch), v0 upload-pack
// (fetch), v0 receive-pack (push), and the info/refs advertisements.
// Node 22 standard library only. No git binary anywhere.

import type { IncomingHttpHeaders, ServerResponse } from 'node:http';
import {
  ZERO_OID,
  generatePack,
  isOid,
  parseCommit,
  parseObject,
  parsePack,
  parseTree,
} from './gitobj.ts';
import type { Repo, Store } from './store.ts';

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

// ---------------------------------------------------------------- pkt-line

function pkt(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = payload.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]);
}
const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

interface PktLine {
  kind: 'data' | 'flush' | 'delim' | 'end';
  data?: Buffer;
}

/** Decode pkt-lines from a buffer; returns lines and the offset just past them. */
function decodePktLines(buf: Buffer, start = 0): { lines: PktLine[]; offset: number } {
  const lines: PktLine[] = [];
  let off = start;
  while (off + 4 <= buf.length) {
    const lenHex = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(lenHex)) break;
    const len = parseInt(lenHex, 16);
    if (len === 0) {
      lines.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (len === 1) {
      lines.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      lines.push({ kind: 'end' });
      off += 4;
      continue;
    }
    if (off + len > buf.length) break;
    lines.push({ kind: 'data', data: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { lines, offset: off };
}

/** Split data into sideband packets (band byte + chunk), each a pkt-line. */
function sideband(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const MAX = 65515; // 65520 max pkt-line - 4 header - 1 band byte
  for (let off = 0; off < data.length; off += MAX) {
    const chunk = data.subarray(off, Math.min(data.length, off + MAX));
    out.push(pkt(Buffer.concat([Buffer.from([band]), chunk])));
  }
  if (data.length === 0) out.push(pkt(Buffer.from([band])));
  return out;
}

// ---------------------------------------------------------------- refs

interface RefInfo {
  name: string;
  oid: string;
  peeled?: string;
}

function listRefs(repo: Repo): RefInfo[] {
  const refs: RefInfo[] = [];
  for (const [ref, oid] of repo.refs) {
    const info: RefInfo = { name: ref, oid };
    if (ref.startsWith('refs/tags/')) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        const m = /^object ([0-9a-f]{40})\n/.exec(obj.payload.toString('utf8'));
        if (m !== null) info.peeled = m[1];
      }
    }
    refs.push(info);
  }
  refs.sort((a, b) => (a.name < b.name ? -1 : 1));
  return refs;
}

const UPLOAD_CAPS = 'side-band-64k thin-pack ofs-delta agent=forge/1.0 symref=HEAD:refs/heads/main object-format=sha1 multi_ack_detailed shallow';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0 symref=HEAD:refs/heads/main object-format=sha1';

function v0Advertisement(service: 'upload' | 'receive', repo: Repo): Buffer {
  const parts: Buffer[] = [];
  parts.push(pkt(`# service=git-${service === 'upload' ? 'upload' : 'receive'}-pack\n`));
  // The service line is its own header section, terminated by a flush
  // packet; the ref advertisement follows. git's check_smart_http consumes
  // packets until a flush here, so omitting it swallows the refs.
  parts.push(FLUSH);
  const caps = service === 'upload' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const refs = listRefs(repo);
  const mainTip = repo.refs.get('refs/heads/main');
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = mainTip ?? refs[0].oid;
    parts.push(pkt(`${headOid} HEAD\0${caps}\n`));
    for (const r of refs) {
      parts.push(pkt(`${r.oid} ${r.name}\n`));
      if (r.peeled !== undefined) parts.push(pkt(`${r.peeled} ${r.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt('agent=forge/1.0\n'),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow filter\n'),
    pkt('object-format=sha1\n'),
    FLUSH,
  ]);
}

// ---------------------------------------------------------------- fetch planning

// Fetch responses are deterministic for a given repo version + request, and
// the benchmark clones the same repo 50 times concurrently: cache the whole
// response (bounded, FIFO eviction). gitVersion bumps on every object/ref
// change, so a cached response can never be stale.
const FETCH_CACHE_MAX = 64;
const fetchCache = new Map<string, Buffer>();
function fetchCacheKey(
  variant: 'v2' | 'v0',
  repo: Repo,
  wants: string[],
  haves: string[],
  depth: number | null,
  oldShallow: string[],
): string {
  return [
    variant,
    `${repo.owner}/${repo.name}@${repo.gitVersion}`,
    [...wants].sort().join(','),
    [...haves].sort().join(','),
    depth === null ? '' : String(depth),
    [...oldShallow].sort().join(','),
  ].join('|');
}
function fetchCacheGet(key: string): Buffer | undefined {
  return fetchCache.get(key);
}
function fetchCachePut(key: string, value: Buffer): void {
  if (fetchCache.size >= FETCH_CACHE_MAX) {
    const first = fetchCache.keys().next().value;
    if (first !== undefined) fetchCache.delete(first);
  }
  fetchCache.set(key, value);
}

interface FetchPlan {
  objects: { type: string; payload: Buffer }[];
  shallow: string[];
  unshallow: string[];
}

/** Collect objects to send for wants, honoring haves and depth. */
function planFetch(repo: Repo, wants: string[], haves: string[], depth: number | null, oldShallow: string[]): FetchPlan {
  // Reachable set from haves (anything the client already holds is not re-sent).
  // A have that is also a shallow boundary (listed in `shallow` args) is held
  // itself, with its tree and blobs — but NOT its parents: a shallow clone
  // does not hold the history below its boundary, and a deepen fetch must
  // deliver exactly those parents.
  const held = new Set<string>();
  {
    const stack = [...haves];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (held.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      held.add(oid);
      if (obj.type === 'commit') {
        const c = parseCommit(obj.payload);
        stack.push(c.tree);
        if (!oldShallow.includes(oid)) stack.push(...c.parents);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.payload)) stack.push(e.oid);
      } else if (obj.type === 'tag') {
        const m = /^object ([0-9a-f]{40})\n/.exec(obj.payload.toString('utf8'));
        if (m !== null) stack.push(m[1]);
      }
    }
  }

  // Generations from wants (gen 0 = want commits).
  const gen = new Map<string, number>();
  const queue: { oid: string; g: number }[] = wants.filter(isOid).map((oid) => ({ oid, g: 0 }));
  const includedCommits = new Map<string, number>();
  while (queue.length > 0) {
    const { oid, g } = queue.shift()!;
    if (gen.has(oid)) continue;
    gen.set(oid, g);
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      includedCommits.set(oid, g);
      if (depth === null || g + 1 < depth) {
        const c = parseCommit(obj.payload);
        for (const p of c.parents) queue.push({ oid: p, g: g + 1 });
      }
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})\n/.exec(obj.payload.toString('utf8'));
      if (m !== null) queue.push({ oid: m[1], g });
    }
  }

  // Shallow boundaries: included commits at the deepest generation whose
  // parents were not included.
  const shallow: string[] = [];
  for (const [oid, g] of includedCommits) {
    if (depth !== null && g === depth - 1) {
      const c = parseCommit(repo.objects.get(oid)!.payload);
      if (c.parents.length > 0) shallow.push(oid);
    }
  }
  // Old boundaries that are now included with their parents present are unshallow.
  const unshallow: string[] = [];
  for (const old of oldShallow) {
    if (includedCommits.has(old) && !shallow.includes(old)) unshallow.push(old);
  }

  // Objects to send: everything reachable from included commits/tags, minus held.
  const send = new Map<string, { type: string; payload: Buffer }>();
  const stack: string[] = [...includedCommits.keys()];
  // Also include tag objects themselves when wanted directly.
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (obj !== undefined && obj.type === 'tag') stack.push(w);
  }
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (send.has(oid) || held.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    send.set(oid, obj);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.payload);
      // Only walk parents that were included (depth-limited).
      for (const p of c.parents) if (includedCommits.has(p)) stack.push(p);
      stack.push(c.tree);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.payload)) stack.push(e.oid);
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})\n/.exec(obj.payload.toString('utf8'));
      if (m !== null && includedCommits.has(m[1])) stack.push(m[1]);
    }
  }
  return { objects: [...send.values()], shallow, unshallow };
}

// ---------------------------------------------------------------- upload-pack v2

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const a of args) {
    if (a === 'peel') peel = true;
    else if (a === 'symrefs') symrefs = true;
    else if (a === 'unborn') unborn = true;
    else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  const refs = listRefs(repo);
  const mainTip = repo.refs.get('refs/heads/main');
  const match = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (mainTip !== undefined && match('HEAD')) {
    parts.push(pkt(`${mainTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
  }
  for (const r of refs) {
    if (!match(r.name)) continue;
    parts.push(pkt(`${r.oid} ${r.name}${peel && r.peeled !== undefined ? ` peeled:${r.peeled}` : ''}\n`));
  }
  if (refs.length === 0 && unborn) {
    parts.push(pkt('unborn HEAD symref-target:refs/heads/main\n'));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV2(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowArgs: string[] = [];
  let depth: number | null = null;
  let done = false;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) shallowArgs.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) depth = parseInt(a.slice(7), 10);
    else if (a === 'done') done = true;
  }
  // Protocol v2 (as implemented by git's upload-pack / fetch-pack):
  // - A request WITHOUT `done` is a negotiation round: answer only with the
  //   acknowledgments section (NAK here; the client sends another round)
  //   terminated by FLUSH.
  // - A request WITH `done` is answered with the pack directly: optional
  //   shallow-info section, then the packfile section. NO acknowledgments
  //   section is sent in this case (git dies on it: "expected 'packfile'").
  if (!done) {
    return Buffer.concat([pkt('acknowledgments\n'), pkt('NAK\n'), FLUSH]);
  }
  const key = fetchCacheKey('v2', repo, wants, haves, depth, shallowArgs);
  const hit = fetchCacheGet(key);
  if (hit !== undefined) return hit;
  const plan = planFetch(repo, wants, haves, depth, shallowArgs);
  const pack = generatePack(plan.objects);
  const parts: Buffer[] = [];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pkt('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pkt(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pkt(`unshallow ${s}\n`));
    parts.push(DELIM);
  }
  parts.push(pkt('packfile\n'));
  for (const p of sideband(1, pack)) parts.push(p);
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  fetchCachePut(key, out);
  return out;
}

function parseV2Command(body: Buffer): { command: string; args: string[] } | null {
  const { lines } = decodePktLines(body);
  let command = '';
  const args: string[] = [];
  let afterDelim = false;
  for (const l of lines) {
    if (l.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (l.kind === 'flush') break;
    if (l.kind !== 'data' || l.data === undefined) continue;
    const text = l.data.toString('utf8').replace(/\n$/, '');
    if (!afterDelim) {
      if (text.startsWith('command=')) command = text.slice('command='.length);
    } else {
      args.push(text);
    }
  }
  return command === '' ? null : { command, args };
}

// ---------------------------------------------------------------- upload-pack v0

function handleFetchV0(repo: Repo, body: Buffer): Buffer {
  const { lines } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallowArgs: string[] = [];
  let depth: number | null = null;
  let inHaves = false;
  for (const l of lines) {
    if (l.kind === 'flush') {
      inHaves = true;
      continue;
    }
    if (l.kind !== 'data' || l.data === undefined) continue;
    const text = l.data.toString('utf8').replace(/\n$/, '');
    const clean = text.split('\0')[0];
    if (clean.startsWith('want ')) wants.push(clean.slice(5).split(' ')[0]);
    else if (clean.startsWith('shallow ')) shallowArgs.push(clean.slice(8).trim());
    else if (clean.startsWith('deepen ')) depth = parseInt(clean.slice(7), 10);
    else if (inHaves && clean.startsWith('have ')) haves.push(clean.slice(5).trim());
  }
  const key = fetchCacheKey('v0', repo, wants, haves, depth, shallowArgs);
  const hit = fetchCacheGet(key);
  if (hit !== undefined) return hit;
  const plan = planFetch(repo, wants, haves, depth, shallowArgs);
  const pack = generatePack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(pkt('NAK\n'));
  for (const s of plan.shallow) parts.push(pkt(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pkt(`unshallow ${s}\n`));
  for (const p of sideband(1, pack)) parts.push(p);
  parts.push(FLUSH);
  const out = Buffer.concat(parts);
  fetchCachePut(key, out);
  return out;
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { lines, offset } = decodePktLines(body);
  const commands: PushCommand[] = [];
  let useSideband = false;
  for (const l of lines) {
    if (l.kind === 'flush') break;
    if (l.kind !== 'data' || l.data === undefined) continue;
    const text = l.data.toString('utf8').replace(/\n$/, '');
    const [cmdPart, capsPart] = text.split('\0');
    if (capsPart !== undefined && capsPart.includes('side-band-64k')) useSideband = true;
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(cmdPart);
    if (m !== null) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(offset);
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  if (needsPack && packBytes.length > 0) {
    try {
      const objects = parsePack(packBytes, (oid) => {
        const o = repo.objects.get(oid);
        return o === undefined ? undefined : Buffer.concat([Buffer.from(`${o.type} ${o.payload.length}\0`, 'ascii'), o.payload]);
      });
      for (const o of objects) {
        if (!repo.objects.has(o.oid)) repo.objects.set(o.oid, { type: o.type, payload: o.payload });
      }
    } catch (e) {
      unpackOk = false;
      unpackDetail = e instanceof Error ? e.message.slice(0, 120) : 'unpack failed';
    }
  } else if (needsPack && packBytes.length === 0) {
    unpackOk = false;
    unpackDetail = 'unpacker error';
  }

  const reportLines: string[] = [];
  reportLines.push(unpackOk ? 'unpack ok' : `unpack ${unpackDetail}`);
  for (const cmd of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${cmd.ref} unpack failed`);
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reportLines.push(`ng ${cmd.ref} ref does not exist`);
      } else if (current !== cmd.oldOid && cmd.oldOid !== ZERO_OID) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      } else {
        repo.refs.delete(cmd.ref);
        reportLines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    const newObj = repo.objects.get(cmd.newOid);
    if (newObj === undefined || (newObj.type !== 'commit' && newObj.type !== 'tag')) {
      reportLines.push(`ng ${cmd.ref} object not found`);
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      if (current !== undefined) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}`);
      }
      continue;
    }
    if (current !== cmd.oldOid) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    // Fast-forward: for a commit tip the new tip must descend from old.
    // A tag tip has no ancestry to check; matching old is enough.
    if (newObj.type === 'commit' && !isAncestor(repo, cmd.oldOid, cmd.newOid)) {
      reportLines.push(`ng ${cmd.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    reportLines.push(`ok ${cmd.ref}`);
  }

  const reportText = reportLines.map((l) => `${l}\n`).join('');
  // Any object/ref change invalidates cached fetch packs.
  repo.gitVersion += 1;
  // The report stream itself ends with a flush packet *inside* the
  // sideband data (as real receive-pack does): the client's packet reader
  // dies with "the remote end hung up unexpectedly" if it hits EOF instead.
  const framed = Buffer.concat([...reportLines.map((l) => pkt(`${l}\n`)), FLUSH]);
  void reportText;
  const parts: Buffer[] = [];
  if (useSideband) {
    for (const p of sideband(1, framed)) parts.push(p);
  } else {
    parts.push(framed);
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** Walk parents using only the repo's own object map. */
function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === anc) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'commit') continue;
    stack.push(...parseCommit(obj.payload).parents);
  }
  return false;
}

// ---------------------------------------------------------------- dispatcher

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

export async function handleGit(
  store: Store,
  _viewer: string,
  owner: string,
  repoName: string,
  subpath: string,
  method: string,
  headers: IncomingHttpHeaders,
  body: Buffer,
  res: ServerResponse,
  service?: string,
): Promise<void> {
  const repo = store.getRepo(owner, repoName);
  const gitProtocol = typeof headers['git-protocol'] === 'string' ? headers['git-protocol'] : '';
  const notFound = (): void => {
    sendBuffer(res, 404, 'application/json; charset=utf-8', Buffer.from('{"message":"Not Found"}\n', 'utf8'));
  };

  if (method === 'GET' && subpath === '/info/refs') {
    if (repo === undefined) {
      notFound();
      return;
    }
    if (service === 'git-receive-pack') {
      sendBuffer(res, 200, RECEIVE_AD, v0Advertisement('receive', repo));
      return;
    }
    // git-upload-pack (or unknown): v2 when the client asks for it, else v0.
    if (gitProtocol === 'version=2') {
      sendBuffer(res, 200, UPLOAD_AD, v2Advertisement());
    } else {
      sendBuffer(res, 200, UPLOAD_AD, v0Advertisement('upload', repo));
    }
    return;
  }

  if (method === 'POST' && subpath === '/git-upload-pack') {
    if (repo === undefined) {
      notFound();
      return;
    }
    if (gitProtocol === 'version=2') {
      const cmd = parseV2Command(body);
      if (cmd === null) {
        sendBuffer(res, 200, UPLOAD_RESULT, Buffer.concat([pkt('ERR bad request\n'), FLUSH]));
        return;
      }
      if (cmd.command === 'ls-refs') {
        sendBuffer(res, 200, UPLOAD_RESULT, handleLsRefs(repo, cmd.args));
        return;
      }
      if (cmd.command === 'fetch') {
        sendBuffer(res, 200, UPLOAD_RESULT, handleFetchV2(repo, cmd.args));
        return;
      }
      sendBuffer(res, 200, UPLOAD_RESULT, Buffer.concat([pkt('ERR unknown command\n'), FLUSH]));
      return;
    }
    sendBuffer(res, 200, UPLOAD_RESULT, handleFetchV0(repo, body));
    return;
  }

  if (method === 'POST' && subpath === '/git-receive-pack') {
    if (repo === undefined) {
      notFound();
      return;
    }
    sendBuffer(res, 200, RECEIVE_RESULT, handleReceivePack(repo, body));
    return;
  }

  notFound();
}
