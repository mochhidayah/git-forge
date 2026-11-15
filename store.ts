// store.ts — in-memory data model + git object store, pack codec, pkt-lines, trees/commits.
// No I/O, no clock reads in the request path (timestamps are a deterministic counter).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ------------------------------------------------------------------ hashing

export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, data]));
}

export const ZERO_OID = '0'.repeat(40);
export const OID_RE = /^[0-9a-f]{40}$/;

// ------------------------------------------------------------------ pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

/** Parse a pkt-line stream. Returns items: Buffer payload, or null for flush, 'delim' for delim. */
export function parsePktLines(buf: Buffer): Array<Buffer | null | 'delim'> {
  const out: Array<Buffer | null | 'delim'> = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0) throw new Error('bad pkt-line length');
    if (len === 0) { out.push(null); i += 4; continue; }
    if (len === 1) { out.push('delim'); i += 4; continue; }
    if (len === 2) { out.push(Buffer.alloc(0)); i += 4; continue; }
    if (i + len > buf.length) throw new Error('truncated pkt-line');
    out.push(buf.subarray(i + 4, i + len));
    i += len;
  }
  if (i !== buf.length) throw new Error('trailing bytes after pkt-lines');
  return out;
}

// ------------------------------------------------------------------ git objects

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface GitRepo {
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // refname -> oid
}

export function newGitRepo(): GitRepo {
  return { objects: new Map(), refs: new Map() };
}

export function putObject(repo: GitRepo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: GitRepo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

// ------------------------------------------------------------------ trees

export interface TreeEntry {
  mode: string; // e.g. '100644', '40000'
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp === -1) throw new Error('bad tree: no space');
    const mode = data.subarray(i, sp).toString('ascii');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul === -1) throw new Error('bad tree: no NUL');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    if (nul + 21 > data.length) throw new Error('bad tree: truncated oid');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

/** Git tree sort order: entries sorted by name, directories compared as name + '/'. */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

export function encodeTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of sortTreeEntries(entries)) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree to path -> {oid, mode}. Skips gitlinks (mode 160000). */
export function flattenTree(repo: GitRepo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = getObject(repo, treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') {
      for (const [p, v] of flattenTree(repo, e.oid, path)) out.set(p, v);
    } else if (e.mode === '160000') {
      continue;
    } else {
      out.set(path, { oid: e.oid, mode: e.mode });
    }
  }
  return out;
}

/** Build a tree object from a flat path -> {oid, mode} map. Returns the tree oid. */
export function buildTreeFromFlat(repo: GitRepo, flat: Map<string, { oid: string; mode: string }>): string {
  // Group by first path segment, recurse.
  const build = (paths: Array<{ parts: string[]; oid: string; mode: string }>): string => {
    const dirs = new Map<string, Array<{ parts: string[]; oid: string; mode: string }>>();
    const files: TreeEntry[] = [];
    for (const p of paths) {
      if (p.parts.length === 1) {
        files.push({ mode: p.mode, name: p.parts[0], oid: p.oid });
      } else {
        const head = p.parts[0];
        if (!dirs.has(head)) dirs.set(head, []);
        dirs.get(head)!.push({ parts: p.parts.slice(1), oid: p.oid, mode: p.mode });
      }
    }
    const entries: TreeEntry[] = [...files];
    for (const [name, sub] of dirs) {
      entries.push({ mode: '40000', name, oid: build(sub) });
    }
    const data = encodeTree(entries);
    return putObject(repo, 'tree', data);
  };
  const paths = [...flat.entries()].map(([path, v]) => ({ parts: path.split('/'), oid: v.oid, mode: v.mode }));
  if (paths.length === 0) {
    return putObject(repo, 'tree', Buffer.alloc(0));
  }
  return build(paths);
}

// ------------------------------------------------------------------ commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string; // full "Name <email> ts +0000" line content after "author "
  committer: string;
  message: string;
  raw: Buffer;
}

export function parseCommit(data: Buffer): CommitInfo | null {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  if (headEnd === -1) return null;
  const head = text.slice(0, headEnd);
  const message = text.slice(headEnd + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (!OID_RE.test(tree)) return null;
  if (parents.some((p) => !OID_RE.test(p))) return null;
  return { tree, parents, author, committer, message, raw: data };
}

export function buildCommitData(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  let s = `tree ${tree}\n`;
  for (const p of parents) s += `parent ${p}\n`;
  s += `author ${author}\ncommitter ${committer}\n\n${message}`;
  return Buffer.from(s, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo | null {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  if (headEnd === -1) return null;
  const head = text.slice(0, headEnd);
  const message = text.slice(headEnd + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  if (!OID_RE.test(object)) return null;
  return { object, type, tag, tagger, message };
}

// ------------------------------------------------------------------ graph

/** Is `anc` an ancestor of `desc` (or equal)? Walks commit parents. */
export function isAncestor(repo: GitRepo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === anc) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = getObject(repo, cur);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    if (!c) continue;
    for (const p of c.parents) stack.push(p);
  }
  return false;
}

/** First common ancestor of a and b (nearest to a), or null. */
export function mergeBase(repo: GitRepo, a: string, b: string): string | null {
  const ancA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const cur = stackA.pop()!;
    if (ancA.has(cur)) continue;
    ancA.add(cur);
    const obj = getObject(repo, cur);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    if (!c) continue;
    for (const p of c.parents) stackA.push(p);
  }
  const stackB = [b];
  const seenB = new Set<string>();
  while (stackB.length > 0) {
    const cur = stackB.pop()!;
    if (ancA.has(cur)) return cur;
    if (seenB.has(cur)) continue;
    seenB.add(cur);
    const obj = getObject(repo, cur);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    if (!c) continue;
    for (const p of c.parents) stackB.push(p);
  }
  return null;
}

/** All commits reachable from `tip`, newest-first (BFS by generation, parents after children). */
export function reachableCommits(repo: GitRepo, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = getObject(repo, cur);
    if (!obj || obj.type !== 'commit') continue;
    out.push(cur);
    const c = parseCommit(obj.data);
    if (!c) continue;
    for (const p of c.parents) queue.push(p);
  }
  return out;
}

/** Full object closure reachable from a set of tip oids (commits -> trees -> blobs, tags -> target). */
export function reachableObjects(repo: GitRepo, tips: string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      if (!c) continue;
      stack.push(c.tree);
      for (const p of c.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000') stack.push(e.oid);
      }
    } else if (obj.type === 'tag') {
      const t = parseTag(obj.data);
      if (t) stack.push(t.object);
    }
  }
  return out;
}

// ------------------------------------------------------------------ packfiles

const PACK_TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Write a pack v2 with plain (non-delta) entries. `oids` are object ids present in the repo. */
export function writePack(repo: GitRepo, oids: Iterable<string>): Buffer {
  const list = [...oids].sort();
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const oid of list) {
    const obj = getObject(repo, oid);
    if (!obj) continue;
    const typeCode = PACK_TYPE_CODES[obj.type];
    const size = obj.data.length;
    // varint: low 4 bits of size in first byte, then 7 bits per byte; type in bits 4-6.
    const sizeBytes: number[] = [];
    let s = size;
    sizeBytes.push(s & 0x0f);
    s >>= 4;
    while (s > 0) {
      sizeBytes.push(s & 0x7f);
      s >>= 7;
    }
    const headBytes: number[] = [];
    for (let i = 0; i < sizeBytes.length; i++) {
      let b = sizeBytes[i];
      if (i === 0) b |= typeCode << 4;
      if (i < sizeBytes.length - 1) b |= 0x80;
      headBytes.push(b);
    }
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = sha1(body);
  return Buffer.concat([body, Buffer.from(trailer, 'hex')]);
}

/** Empty pack (0 objects): 12-byte header + 20-byte trailer. */
export function emptyPack(): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(0, 8);
  return Buffer.concat([header, Buffer.from(sha1(header), 'hex')]);
}

/** Inflate exactly one zlib stream starting at `off`. Returns the data and the offset just past the stream. */
/** Adler-32 checksum of the uncompressed data (the last 4 bytes of a zlib stream, big-endian). */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  let i = 0;
  const n = data.length;
  while (i < n) {
    const end = Math.min(i + 5552, n);
    while (i < end) {
      a += data[i];
      b += a;
      i++;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

export function inflateOne(buf: Buffer, off: number): { data: Buffer; next: number } {
  // inflateSync ignores trailing bytes and returns the FIRST stream's data, so one inflation gives
  // the payload; the stream's true end is then located by its trailing Adler-32 checksum (the last
  // 4 bytes of a zlib stream). Scan for the checksum bytes and verify the first candidate by
  // re-inflating exactly that prefix — typically 2 inflations instead of ~log2(n) binary-search
  // probes. Falls back to the binary search if no candidate verifies.
  const rest = buf.subarray(off);
  const data = inflateSync(rest);
  const sum = adler32(data);
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(sum, 0);
  let from = 2; // skip the 2-byte zlib header
  while (true) {
    const idx = rest.indexOf(needle, from);
    if (idx < 0) break;
    const end = idx + 4;
    try {
      const probe = inflateSync(rest.subarray(0, end));
      if (probe.equals(data)) return { data, next: off + end };
    } catch {
      // Not a stream boundary — keep scanning.
    }
    from = idx + 1;
  }
  // Fallback: binary-search the shortest prefix that inflates.
  let lo = off + 1;
  let hi = buf.length;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(off, mid));
      ans = mid;
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (ans === -1) throw new Error('bad zlib stream in pack');
  return { data: inflateSync(buf.subarray(off, ans)), next: ans };
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readDeltaVarint = (): number => {
    let v = 0;
    let shift = 0;
    while (true) {
      const b = delta[off++];
      v |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readDeltaVarint();
  const tgtSize = readDeltaVarint();
  if (srcSize !== base.length) throw new Error('delta source size mismatch');
  const parts: Buffer[] = [];
  let produced = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      let cpOff = 0;
      let cpSize = 0;
      for (let i = 0; i < 4; i++) if (op & (1 << i)) cpOff |= delta[off++] << (8 * i);
      for (let i = 0; i < 3; i++) if (op & (0x10 << i)) cpSize |= delta[off++] << (8 * i);
      if (cpSize === 0) cpSize = 0x10000;
      parts.push(base.subarray(cpOff, cpOff + cpSize));
      produced += cpSize;
    } else if (op !== 0) {
      parts.push(delta.subarray(off, off + op));
      off += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== tgtSize || produced !== tgtSize) throw new Error('delta target size mismatch');
  return out;
}

export interface DecodedPackObject {
  type: GitObjectType;
  data: Buffer;
  oid: string;
}

/** Decode a pack v2/v3. Supports OFS_DELTA and REF_DELTA. Verifies the trailer checksum.
 * `lookupBase` resolves REF_DELTA bases that live outside the pack (e.g. the store). */
export function decodePack(buf: Buffer, lookupBase?: (oid: string) => DecodedPackObject | undefined): DecodedPackObject[] {
  if (buf.length < 32) throw new Error('pack too small');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  if (sha1(buf.subarray(0, buf.length - 20)) !== trailer) throw new Error('pack checksum mismatch');
  const raw: Array<{ typeCode: number; size: number; data: Buffer; baseOff: number | null; baseOid: string | null; startOff: number }> = [];
  let off = 12;
  for (let n = 0; n < count; n++) {
    const startOff = off;
    const first = buf[off];
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    off += 1;
    while (buf[off - 1] & 0x80) {
      size |= (buf[off] & 0x7f) << shift;
      shift += 7;
      off += 1;
    }
    let baseOid: string | null = null;
    let baseOff: number | null = null;
    if (typeCode === 6) {
      let b = buf[off++];
      let negOff = b & 0x7f;
      while (b & 0x80) {
        b = buf[off++];
        negOff = ((negOff + 1) << 7) | (b & 0x7f);
      }
      baseOff = startOff - negOff;
    } else if (typeCode === 7) {
      baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const { data, next } = inflateOne(buf, off);
    off = next;
    if (data.length !== size) throw new Error('pack entry size mismatch');
    raw.push({ typeCode, size, data, baseOid, baseOff, startOff });
  }
  // Resolve entries (deltas may reference earlier offsets or oids).
  const byOffset = new Map<number, DecodedPackObject>();
  const resolved: DecodedPackObject[] = [];
  const resolve = (entry: (typeof raw)[number]): DecodedPackObject => {
    const cached = byOffset.get(entry.startOff);
    if (cached) return cached;
    let obj: DecodedPackObject;
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: DecodedPackObject | undefined;
      if (entry.typeCode === 6) {
        base = byOffset.get(entry.baseOff!);
        if (!base) {
          const baseEntry = raw.find((r) => r.startOff === entry.baseOff);
          if (!baseEntry) throw new Error('delta base offset not found');
          base = resolve(baseEntry);
        }
      }
      // REF_DELTA with a base outside the pack: resolve via lookupBase (the store).
      if (entry.typeCode === 7 && !base) {
        base = lookupBase?.(entry.baseOid!);
        if (!base) throw new Error(`REF_DELTA base ${entry.baseOid} not in pack`);
      }
      const data = applyDelta(base!.data, entry.data);
      const type = base!.type;
      obj = { type, data, oid: hashObject(type, data) };
    } else {
      const type = PACK_CODE_TYPES[entry.typeCode];
      if (!type) throw new Error(`unknown pack type code ${entry.typeCode}`);
      obj = { type, data: entry.data, oid: hashObject(type, entry.data) };
    }
    byOffset.set(entry.startOff, obj);
    return obj;
  };
  for (const entry of raw) resolved.push(resolve(entry));
  return resolved;
}

// ------------------------------------------------------------------ domain model

export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

export const STRANGER_LOGIN = 'olgabauer';

export interface Comment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}

export interface Repo {
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  dbId: number;
  seq: number;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, { name: string; color: string }>;
  nextIssue: number;
  nextPull: number;
  git: GitRepo;
}

export class Store {
  repos = new Map<string, Repo>();
  nextDbId = 5000;
  nextCommentId = 1;
  commitCounter = 0;

  static key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(Store.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      dbId: this.nextDbId++,
      seq: this.repos.size,
      issues: [],
      pulls: [],
      labels: new Map(),
      nextIssue: 1,
      nextPull: 1,
      git: newGitRepo(),
    };
    this.repos.set(Store.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Store.key(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const r of this.repos.values()) if (r.owner === owner) out.push(r);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  /** Deterministic commit timestamp: fixed epoch + monotonic counter (unique commits). */
  nextCommitTs(): number {
    return 1735689600 + this.commitCounter++;
  }

  authorLine(ts: number): string {
    return `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
  }

  /** Create a commit object in the repo's git store. Returns the commit oid. */
  makeCommit(repo: Repo, tree: string, parents: string[], message: string): string {
    const ts = this.nextCommitTs();
    const line = this.authorLine(ts);
    const data = buildCommitData(tree, parents, line, line, message);
    return putObject(repo.git, 'commit', data);
  }

  /** Opaque stable global ids (base64url, never the bare database id / number). */
  static gid(kind: string, ...parts: Array<string | number>): string {
    return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
  }

  static decodeGid(gid: string): { kind: string; parts: string[] } | null {
    try {
      const text = Buffer.from(gid, 'base64url').toString('utf8');
      const idx = text.indexOf(':');
      if (idx === -1) return null;
      return { kind: text.slice(0, idx), parts: text.slice(idx + 1).split(':') };
    } catch {
      return null;
    }
  }
}

/** Squash-merge a pull request onto its base branch. Shared by REST + GraphQL. */
export function squashMerge(store: Store, repo: Repo, pr: Pull): { ok: boolean; sha?: string; reason?: string } {
  if (pr.merged || pr.state !== 'open') return { ok: false, reason: 'already-merged' };
  const baseTip = repo.git.refs.get(`refs/heads/${pr.baseRef}`);
  if (!baseTip) return { ok: false, reason: 'no-base' };
  const mb = mergeBase(repo.git, pr.headSha, baseTip);
  if (!mb) return { ok: false, reason: 'conflict' };
  const mbTree = parseCommit(getObject(repo.git, mb)!.data)!.tree;
  const headTree = parseCommit(getObject(repo.git, pr.headSha)!.data)!.tree;
  const baseTipTree = parseCommit(getObject(repo.git, baseTip)!.data)!.tree;
  const baseFlat = flattenTree(repo.git, mbTree);
  const headFlat = flattenTree(repo.git, headTree);
  const tipFlat = flattenTree(repo.git, baseTipTree);
  const changedBy = (from: Map<string, { oid: string; mode: string }>, to: Map<string, { oid: string; mode: string }>): Map<string, string | null> => {
    const out = new Map<string, string | null>();
    const paths = new Set([...from.keys(), ...to.keys()]);
    for (const p of paths) {
      const f = from.get(p);
      const t = to.get(p);
      if (!f && t) out.set(p, t.oid);
      else if (f && !t) out.set(p, null);
      else if (f && t && f.oid !== t.oid) out.set(p, t.oid);
    }
    return out;
  };
  const headChanges = changedBy(baseFlat, headFlat);
  const baseChanges = changedBy(baseFlat, tipFlat);
  for (const [p, hOid] of headChanges) {
    if (baseChanges.has(p) && baseChanges.get(p) !== hOid) return { ok: false, reason: 'conflict' };
  }
  const merged = new Map(tipFlat);
  for (const [p, hOid] of headChanges) {
    if (hOid === null) merged.delete(p);
    else merged.set(p, headFlat.get(p)!);
  }
  const treeOid = buildTreeFromFlat(repo.git, merged);
  const commitOid = store.makeCommit(repo, treeOid, [baseTip], `${pr.title} (#${pr.number})`);
  repo.git.refs.set(`refs/heads/${pr.baseRef}`, commitOid);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = '2025-01-01T00:00:00Z';
  pr.mergeCommitSha = commitOid;
  return { ok: true, sha: commitOid };
}
