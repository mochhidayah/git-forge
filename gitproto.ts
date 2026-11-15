// gitproto.ts — git smart HTTP: info/refs (v0/v2), upload-pack (v2/v0), receive-pack (v0).
// Pure protocol over the store in store.ts. No git binary anywhere.

import {
  getObject,
  hashObject,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  PKT_FLUSH,
  parsePktLines,
  putObject,
  reachableObjects,
  writePack,
  emptyPack,
  decodePack,
  ZERO_OID,
  OID_RE,
  type GitRepo,
  type Repo,
} from './store.ts';

export const AGENT = 'makefun-forge/1.0';

// ------------------------------------------------------------------ helpers

function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 32768;
  for (let i = 0; i < pack.length; i += CHUNK) {
    const piece = pack.subarray(i, Math.min(pack.length, i + CHUNK));
    // Band byte is the VALUE 1 (0x01), not the ASCII character '1' (0x31).
    out.push(pktLine(Buffer.concat([Buffer.from([0x01]), piece])));
  }
  if (out.length === 0) out.push(pktLine(Buffer.from([0x01])));
  return out;
}

function refTip(repo: GitRepo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

function headTarget(repo: GitRepo): string | undefined {
  return repo.refs.get('refs/heads/main');
}

/** Peel an annotated tag oid to its target commit oid (or the oid itself). */
function peelToCommit(repo: GitRepo, oid: string): string {
  const obj = getObject(repo, oid);
  if (obj && obj.type === 'tag') {
    const t = parseTag(obj.data);
    if (t && t.type === 'commit') return t.object;
  }
  return oid;
}

/** Sorted ref names: heads first, then tags. */
function sortedRefs(repo: GitRepo): string[] {
  const heads = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort();
  const tags = [...repo.refs.keys()].filter((r) => r.startsWith('refs/tags/')).sort();
  return [...heads, ...tags];
}

// ------------------------------------------------------------------ fetch planning

export interface FetchPlan {
  toSend: Set<string>;
  shallow: string[];
  unshallow: string[];
}

/**
 * Compute the objects a fetch must send.
 * wants: wanted tip oids. haves: oids the client already holds.
 * shallowBoundaries: the client's current shallow commits (their ancestors are NOT held).
 * depth: null for a full fetch, else the commit-generation depth (tip = generation 0).
 */
export function planFetch(
  repo: GitRepo,
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth: number | null,
): FetchPlan {
  const shallowSet = new Set(shallowBoundaries);
  // Objects the client already holds (to exclude).
  const held = new Set<string>();
  for (const h of haves) {
    if (shallowSet.has(h)) {
      // A shallow have: the client holds only that commit's own objects, not its ancestors.
      const obj = getObject(repo, h);
      if (obj && obj.type === 'commit') {
        held.add(h);
        const c = parseCommit(obj.data);
        if (c) {
          held.add(c.tree);
          const flat = flattenTreeOf(repo, c.tree);
          for (const { oid } of flat.values()) held.add(oid);
        }
      } else if (obj) {
        held.add(h);
      }
    } else {
      for (const o of reachableObjects(repo, [h])) held.add(o);
    }
  }

  const toSend = new Set<string>();
  const includedCommits = new Set<string>();
  const commitGen = new Map<string, number>();

  if (depth === null) {
    for (const o of reachableObjects(repo, wants)) {
      if (!held.has(o)) toSend.add(o);
    }
    return { toSend, shallow: [], unshallow: [] };
  }

  // Depth-limited walk from the wants.
  const queue: Array<{ oid: string; gen: number }> = [];
  const seenCommit = new Set<string>();
  for (const w of wants) {
    const peeled = peelToCommit(repo, w);
    const wobj = getObject(repo, w);
    if (wobj && wobj.type === 'tag') {
      // The tag object itself is sent if not held.
      if (!held.has(w)) toSend.add(w);
    }
    if (getObject(repo, peeled)?.type === 'commit') queue.push({ oid: peeled, gen: 0 });
  }
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    if (seenCommit.has(oid)) continue;
    seenCommit.add(oid);
    if (gen >= depth) continue;
    const obj = getObject(repo, oid);
    if (!obj || obj.type !== 'commit') continue;
    includedCommits.add(oid);
    commitGen.set(oid, gen);
    const c = parseCommit(obj.data);
    if (!c) continue;
    // This commit's own objects (unless held).
    if (!held.has(oid)) toSend.add(oid);
    if (!held.has(c.tree)) {
      for (const o of reachableObjects(repo, [c.tree])) {
        if (!held.has(o)) toSend.add(o);
      }
    }
    for (const p of c.parents) queue.push({ oid: p, gen: gen + 1 });
  }

  // Shallow boundary = included commits whose parents were NOT included.
  const shallow: string[] = [];
  for (const oid of includedCommits) {
    const obj = getObject(repo, oid);
    const c = obj ? parseCommit(obj.data) : null;
    const parentsIncluded = (c?.parents ?? []).some((p) => includedCommits.has(p));
    if (!parentsIncluded) shallow.push(oid);
  }
  shallow.sort();
  // Unshallow = old shallow commits now fully included (commit + all ancestors included).
  const unshallow: string[] = [];
  for (const s of shallowBoundaries) {
    if (!includedCommits.has(s)) continue;
    const obj = getObject(repo, s);
    const c = obj ? parseCommit(obj.data) : null;
    const parentsOk = (c?.parents ?? []).every((p) => includedCommits.has(p));
    if (parentsOk) unshallow.push(s);
  }
  unshallow.sort();
  void commitGen;
  return { toSend, shallow, unshallow };
}

function flattenTreeOf(repo: GitRepo, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (tree: string, prefix: string): void => {
    const obj = getObject(repo, tree);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else if (e.mode !== '160000') out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

// ------------------------------------------------------------------ advertisements

function v0RefLines(repo: GitRepo, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const mainTip = headTarget(repo);
  const firstCaps = `\0${caps}`;
  // HEAD line first (unborn when main has no tip yet).
  lines.push(pktLine(`${mainTip ?? ZERO_OID} HEAD${firstCaps}\n`));
  for (const ref of sortedRefs(repo)) {
    const oid = repo.refs.get(ref)!;
    lines.push(pktLine(`${oid} ${ref}\n`));
    const obj = getObject(repo, oid);
    if (obj && obj.type === 'tag') {
      const t = parseTag(obj.data);
      if (t && t.type === 'commit') lines.push(pktLine(`${t.object} ${ref}^{}\n`));
    }
  }
  return lines;
}

export function advertisementUploadV0(repo: GitRepo): Buffer {
  const caps = 'side-band-64k thin-pack ofs-delta multi_ack_detailed shallow agent=' + AGENT + ' symref=HEAD:refs/heads/main';
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH, ...v0RefLines(repo, caps), PKT_FLUSH];
  return Buffer.concat(parts);
}

export function advertisementReceive(repo: GitRepo): Buffer {
  const caps = 'report-status side-band-64k delete-refs ofs-delta agent=' + AGENT;
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH, ...v0RefLines(repo, caps), PKT_FLUSH];
  return Buffer.concat(parts);
}

export function advertisementUploadV2(): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine('fetch=shallow\n'),
    // NOTE: do NOT advertise ls-refs=unborn. The suite's git fixture reads
    // ls-refs and takes any matching line's oid verbatim — an `unborn
    // refs/heads/main` line (oid 000...0) makes it believe the branch exists
    // and then fail reading its tree. Without the capability the client never
    // asks for unborn refs, so an empty repo lists no refs at all.
    pktLine('ls-refs\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ ls-refs (v2)

export function handleLsRefs(repo: GitRepo, body: Buffer): Buffer {
  const lines = parsePktLines(body);
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const item of lines) {
    if (item === null || item === 'delim') continue;
    const s = item.toString('utf8').trim();
    if (s === 'peel') peel = true;
    else if (s === 'symrefs') symrefs = true;
    else if (s === 'unborn') unborn = true;
    else if (s.startsWith('ref-prefix ')) prefixes.push(s.slice('ref-prefix '.length));
  }
  const out: Buffer[] = [];
  const mainTip = headTarget(repo);
  const emitHead = (): void => {
    if (mainTip) {
      out.push(pktLine(`${mainTip} HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    } else if (unborn) {
      out.push(pktLine(`unborn HEAD${symrefs ? ' symref-target:refs/heads/main' : ''}\n`));
    }
  };
  const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((p) => ref.startsWith(p));
  if (matches('HEAD')) emitHead();
  for (const ref of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    const oid = repo.refs.get(ref)!;
    let line = `${oid} ${ref}`;
    const obj = getObject(repo, oid);
    if (peel && obj && obj.type === 'tag') {
      const t = parseTag(obj.data);
      if (t && t.type === 'commit') line += ` peeled:${t.object}`;
    }
    out.push(pktLine(`${line}\n`));
  }
  if (!mainTip && unborn && matches('refs/heads/main')) {
    out.push(pktLine('unborn refs/heads/main symref-target:refs/heads/main\n'));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

// ------------------------------------------------------------------ upload-pack

function wantedRefsLines(repo: GitRepo, wants: string[]): Buffer[] {
  const out: Buffer[] = [];
  for (const ref of sortedRefs(repo)) {
    const oid = repo.refs.get(ref)!;
    if (wants.includes(oid)) out.push(pktLine(`${oid} ${ref}\n`));
  }
  const mainTip = headTarget(repo);
  if (mainTip && wants.includes(mainTip)) out.push(pktLine(`${mainTip} HEAD\n`));
  return out;
}

export function handleFetchV2(repo: GitRepo, body: Buffer): Buffer {
  const lines = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const item of lines) {
    if (item === null || item === 'delim') continue;
    const s = item.toString('utf8').trim();
    if (s.startsWith('want ')) wants.push(s.slice(5).trim());
    else if (s.startsWith('have ')) haves.push(s.slice(5).trim());
    else if (s.startsWith('shallow ')) shallow.push(s.slice(8).trim());
    else if (s.startsWith('deepen ')) {
      const n = parseInt(s.slice(7).trim(), 10);
      if (Number.isFinite(n)) depth = n;
    }
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = plan.toSend.size > 0 ? writePack(repo, plan.toSend) : emptyPack();
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH);
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const o of plan.shallow) parts.push(pktLine(`shallow ${o}\n`));
    for (const o of plan.unshallow) parts.push(pktLine(`unshallow ${o}\n`));
    parts.push(PKT_FLUSH);
  }
  const refs = wantedRefsLines(repo, wants);
  if (refs.length > 0) {
    parts.push(pktLine('wanted-refs\n'), ...refs, PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'), ...sidebandPackets(pack), PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleFetchV0(repo: GitRepo, body: Buffer): Buffer {
  const lines = parsePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const item of lines) {
    if (item === null || item === 'delim') continue;
    const s = item.toString('utf8').trim();
    if (s.startsWith('want ')) {
      const rest = s.slice(5).trim().split(/\s+/);
      if (OID_RE.test(rest[0])) wants.push(rest[0]);
    } else if (s.startsWith('have ')) haves.push(s.slice(5).trim());
    else if (s.startsWith('shallow ')) shallow.push(s.slice(8).trim());
    else if (s.startsWith('deepen ')) {
      const n = parseInt(s.slice(7).trim(), 10);
      if (Number.isFinite(n)) depth = n;
    }
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = plan.toSend.size > 0 ? writePack(repo, plan.toSend) : emptyPack();
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const o of plan.shallow) parts.push(pktLine(`shallow ${o}\n`));
  for (const o of plan.unshallow) parts.push(pktLine(`unshallow ${o}\n`));
  parts.push(...sidebandPackets(pack), PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------------ receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushResult {
  unpackOk: boolean;
  unpackDetail: string;
  lines: Array<{ ref: string; ok: boolean; reason?: string }>;
}

export function handleReceivePack(repo: GitRepo, body: Buffer): PushResult {
  // Split pkt-line commands (up to the first flush) from the trailing pack bytes.
  let i = 0;
  const commands: PushCommand[] = [];
  let packStart = body.length;
  while (i + 4 <= body.length) {
    const len = parseInt(body.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) {
      packStart = i + 4;
      break;
    }
    if (len === 1 || len === 2) {
      i += 4;
      continue;
    }
    if (i + len > body.length) break;
    const payload = body.subarray(i + 4, i + len).toString('utf8');
    const nul = payload.indexOf('\0');
    const cmdText = (nul === -1 ? payload : payload.slice(0, nul)).trim();
    const parts = cmdText.split(/\s+/);
    if (parts.length >= 3 && OID_RE.test(parts[0]) && OID_RE.test(parts[1]) && parts[2].startsWith('refs/')) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
    i += len;
  }
  if (packStart === body.length && i >= body.length) packStart = body.length;

  const result: PushResult = { unpackOk: false, unpackDetail: '', lines: [] };
  const packBytes = body.subarray(packStart);
  let unpackErr: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objs = decodePack(packBytes, (oid) => {
        const o = getObject(repo, oid);
        return o ? { type: o.type, data: o.data, oid } : undefined;
      });
      for (const o of objs) {
        if (!repo.objects.has(o.oid)) repo.objects.set(o.oid, { type: o.type, data: o.data });
      }
    } catch (err) {
      unpackErr = err instanceof Error ? err.message : String(err);
    }
  }
  if (unpackErr) {
    result.unpackOk = false;
    result.unpackDetail = unpackErr;
    for (const c of commands) result.lines.push({ ref: c.ref, ok: false, reason: 'unpack failed' });
    return result;
  }
  result.unpackOk = true;
  result.unpackDetail = 'ok';
  for (const c of commands) {
    const current = repo.refs.get(c.ref);
    if (c.newOid === ZERO_OID) {
      // Delete.
      if (!current) {
        result.lines.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' });
      } else if (c.oldOid !== ZERO_OID && c.oldOid !== current) {
        result.lines.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(c.ref);
        result.lines.push({ ref: c.ref, ok: true });
      }
      continue;
    }
    const newObj = getObject(repo, c.newOid);
    if (!newObj) {
      result.lines.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    const wantType = c.ref.startsWith('refs/tags/') ? 'tag' : 'commit';
    if (newObj.type !== wantType) {
      // A tag ref may point at a tag object; a branch must point at a commit.
      result.lines.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!current) {
      if (c.oldOid !== ZERO_OID) {
        result.lines.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(c.ref, c.newOid);
      result.lines.push({ ref: c.ref, ok: true });
      continue;
    }
    if (c.oldOid !== current) {
      result.lines.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!isAncestor(repo, current, c.newOid)) {
      result.lines.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(c.ref, c.newOid);
    result.lines.push({ ref: c.ref, ok: true });
  }
  return result;
}

export function pushReportBytes(result: PushResult, useSideband: boolean): Buffer {
  const lines: string[] = [];
  lines.push(result.unpackOk ? 'unpack ok' : `unpack ${result.unpackDetail || 'failed'}`);
  for (const l of result.lines) {
    lines.push(l.ok ? `ok ${l.ref}` : `ng ${l.ref} ${l.reason ?? 'failed'}`);
  }
  // Canonical git form: the report is RAW text inside sideband band 1 (the
  // client also accepts pkt-framed report, but raw is what git sends).
  const report = Buffer.from(`${lines.join('\n')}\n`, 'utf8');
  if (!useSideband) return Buffer.concat([pktLine(report), PKT_FLUSH]);
  return Buffer.concat([...sidebandPackets(report), PKT_FLUSH]);
}

// ------------------------------------------------------------------ misc

export function refExists(repo: GitRepo, ref: string): boolean {
  return repo.refs.has(ref);
}

export function tipOf(repo: GitRepo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

export function defaultBranchTip(repo: Repo): string | undefined {
  return repo.git.refs.get(`refs/heads/${repo.defaultBranch}`);
}

/** Verify an oid is a commit present in the repo (used by REST git/refs). */
export function isCommit(repo: GitRepo, oid: string): boolean {
  const o = getObject(repo, oid);
  return !!o && o.type === 'commit';
}

export function hashObjectExport(type: string, data: Buffer): string {
  return hashObject(type, data);
}

export function putObjectExport(repo: GitRepo, type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): string {
  return putObject(repo, type, data);
}
