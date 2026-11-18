// github-forge: a GitHub-compatible git forge (smart HTTP + REST v3 + GraphQL + MCP).
// Single process, in-memory store, Node 22 stdlib only. Entry point is main.ts (kept
// as the kit starter); this file is the whole server. No wall-clock time enters the
// stored state: every timestamp derives from a monotonic sequence counter, so two
// runs on the same instance export identical state.
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
export const VIEWER = { id: 1000, login: 'adaiversen', name: 'ada iversen', email: 'adaiversen@example.invalid' };
export const ZERO_OID = '0000000000000000000000000000000000000000';
const AGENT = 'github-forge/1.0.0';
const BASE_EPOCH = 1767225600; // 2026-01-01T00:00:00Z, deterministic
let seq = 0;
function nextSeq(): number { seq += 1; return seq; }
function isoFor(n: number): string { return new Date((BASE_EPOCH + n) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
// isoFor is pure in n and called for every serialized object; memoize it so
// a timestamp string is built once (Date + toISOString per call was visible
// in profiles of the issue read/write paths).
const isoCache = new Map<number, string>();
function isoForCached(n: number): string {
  let s = isoCache.get(n);
  if (s === undefined) { s = isoFor(n); isoCache.set(n, s); }
  return s;
}
function sha1hex(data: Buffer): string { return crypto.createHash('sha1').update(data).digest('hex'); }

// ---------------------------------------------------------------------------
// pkt-line framing
// ---------------------------------------------------------------------------
function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), body]);
}
function pktFlush(): Buffer { return Buffer.from('0000', 'ascii'); }
function pktDelim(): Buffer { return Buffer.from('0001', 'ascii'); }
type Pkt = { kind: 'data' | 'flush' | 'delim'; payload: Buffer };
function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len) || len < 0) break;
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); i += 4; continue; }
    if (i + len > buf.length) break;
    out.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return out;
}
function encodePktLines(lines: Array<string | 'flush' | 'delim' | Buffer>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(pktFlush());
    else if (line === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Git objects
// ---------------------------------------------------------------------------
type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj { type: ObjType; data: Buffer; }
function objectId(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1hex(Buffer.concat([header, data]));
}
interface TreeEntry { mode: string; name: string; oid: string; }
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, sp);
    const mode = data.subarray(i, sp).toString('ascii');
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? a.name + '/' : a.name;
    const kb = b.mode === '40000' ? b.name + '/' : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
interface CommitView { tree: string; parents: string[]; message: string; authorLine: string; committerLine: string; raw: Buffer; }
function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let authorLine = '';
  let committerLine = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  return { tree, parents, message, authorLine, committerLine, raw: data };
}
function parseTag(data: Buffer): { target: string; type: string } {
  const text = data.toString('utf8');
  const target = (text.match(/^object ([0-9a-f]{40})$/m) ?? [])[1] ?? '';
  const type = (text.match(/^type (\w+)$/m) ?? [])[1] ?? '';
  return { target, type };
}
function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, { mode: string; oid: string }>): void {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else out.set(path, { mode: e.mode, oid: e.oid });
  }
}
function buildTreeFromFlat(repo: Repo, flat: Map<string, { mode: string; oid: string }>): string {
  // Group paths by directory, build bottom-up.
  interface DirNode { files: Map<string, { mode: string; oid: string }>; dirs: Map<string, DirNode>; }
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, ent] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let child = node.dirs.get(parts[i]);
      if (!child) { child = { files: new Map(), dirs: new Map() }; node.dirs.set(parts[i], child); }
      node = child;
    }
    node.files.set(parts[parts.length - 1], ent);
  }
  const build = (node: DirNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, ent] of node.files) entries.push({ mode: ent.mode, name, oid: ent.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = objectId('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}
function commitWalk(repo: Repo, start: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [start];
  while (queue.length && out.length < limit) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return out;
}
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length) {
    const oid = queue.shift()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return false;
}
function findMergeBase(repo: Repo, a: string, b: string): string | null {
  const ancA = new Set(commitWalk(repo, a, 10000));
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length) {
    const oid = queue.shift()!;
    if (ancA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------
function readVarint(buf: Buffer, pos: number): { value: number; next: number } {
  let value = buf[pos] & 0x7f;
  let i = pos + 1;
  while (buf[i - 1] & 0x80) { value = ((value + 1) << 7) | (buf[i] & 0x7f); i += 1; }
  return { value, next: i };
}
// Inflate one zlib stream starting at `start`; the engine reports exactly
// how many input bytes the stream consumed, so a single inflate finds its
// end (a binary search over prefixes re-inflated the stream ~log2(n) times
// per object, which dominated receive-pack time).
function inflateOne(buf: Buffer, start: number): { data: Buffer; next: number } {
  const { buffer: data, engine } = zlib.inflateSync(buf.subarray(start), { info: true });
  return { data, next: start + engine.bytesWritten };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readV = (): number => {
    let v = 0; let shift = 0;
    while (true) { const b = delta[p++]; v |= (b & 0x7f) << shift; shift += 7; if (!(b & 0x80)) break; }
    return v;
  };
  const srcSize = readV();
  const dstSize = readV();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let off = 0; let size = 0;
      if (op & 0x01) off = delta[p++];
      if (op & 0x02) off |= delta[p++] << 8;
      if (op & 0x04) off |= delta[p++] << 16;
      if (op & 0x08) off |= delta[p++] << 24;
      if (op & 0x10) size = delta[p++];
      if (op & 0x20) size |= delta[p++] << 8;
      if (op & 0x40) size |= delta[p++] << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(off, off + size));
      total += size;
    } else if (op) {
      out.push(delta.subarray(p, p + op));
      total += op;
      p += op;
    } else throw new Error('delta op 0');
  }
  const result = Buffer.concat(out);
  if (result.length !== dstSize || total !== dstSize) throw new Error('delta size mismatch');
  return result;
}
const PACK_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
function readPack(buf: Buffer, repo: Repo): Map<string, GitObj> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = buf.readUInt32BE(8);
  let pos = 12;
  const byOffset = new Map<number, GitObj>();
  const pending: Array<{ offset: number; type: ObjType; data: Buffer }> = [];
  const result = new Map<string, GitObj>();
  for (let n = 0; n < count; n++) {
    const start = pos;
    let b = buf[pos++];
    const typeId = (b >> 4) & 0x07;
    let size = b & 0x0f;
    let shift = 4;
    while (b & 0x80) { b = buf[pos++]; size |= (b & 0x7f) << shift; shift += 7; }
    let type: ObjType;
    let baseOid = '';
    let baseOff = -1;
    if (typeId === 6) {
      const v = readVarint(buf, pos);
      baseOff = start - v.value;
      pos = v.next;
    } else if (typeId === 7) {
      baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else {
      type = PACK_TYPES[typeId];
      if (!type) throw new Error(`unknown pack type ${typeId}`);
    }
    const inflated = inflateOne(buf, pos);
    pos = inflated.next;
    if (typeId === 6 || typeId === 7) {
      let base: GitObj | undefined;
      if (typeId === 6) base = byOffset.get(baseOff);
      else base = result.get(baseOid) ?? (repo.objects.has(baseOid) ? repo.objects.get(baseOid)! : undefined);
      if (!base) throw new Error('delta base not found');
      const data = applyDelta(base.data, inflated.data);
      const obj: GitObj = { type: base.type, data };
      const oid = objectId(obj.type, obj.data);
      byOffset.set(start, obj);
      result.set(oid, obj);
      pending.push({ offset: start, type: obj.type, data });
    } else {
      const obj: GitObj = { type: type!, data: inflated.data };
      if (obj.data.length !== size) throw new Error('pack object size mismatch');
      const oid = objectId(obj.type, obj.data);
      byOffset.set(start, obj);
      result.set(oid, obj);
    }
  }
  return result;
}
function writePack(objects: GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeId = PACK_TYPE_IDS[obj.type];
    const size = obj.data.length;
    const hdr: number[] = [];
    let s = size;
    let first = (typeId << 4) | (s & 0x0f);
    s >>= 4;
    if (s) first |= 0x80;
    hdr.push(first);
    while (s) { let b = s & 0x7f; s >>= 7; if (s) b |= 0x80; hdr.push(b); }
    parts.push(Buffer.from(hdr));
    parts.push(zlib.deflateSync(obj.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  const trailer = crypto.createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
interface IssueRec {
  number: number; id: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; createdSeq: number; updatedSeq: number;
  comments: Array<{ id: number; body: string; createdSeq: number }>;
  // Serialized-JSON cache: valid only while updatedSeq/comments match.
  // Every mutation of a serialized field bumps updatedSeq (PATCH, comment
  // add, GraphQL close/addComment), so a version check is a complete
  // invalidation rule — no per-site invalidation to forget.
  jsonCache: { buf: Buffer; updatedSeq: number; comments: number } | null;
}
interface PullRec {
  number: number; id: number; title: string; body: string; state: 'open' | 'closed';
  merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  headRef: string; headSha: string; baseRef: string; baseSha: string;
  createdSeq: number; updatedSeq: number;
}
class Repo {
  id: number;
  name: string;
  owner = VIEWER.login;
  description: string;
  isPrivate: boolean;
  defaultBranch = 'main';
  createdSeq: number;
  objects = new Map<string, GitObj>();
  refs = new Map<string, string>(); // refs/heads/*, refs/tags/* -> oid
  issues: IssueRec[] = [];
  issuesByNum = new Map<number, IssueRec>();
  pulls: PullRec[] = [];
  pullsByNum = new Map<number, PullRec>();
  labels = new Map<string, { name: string; color: string; id: number }>();
  packCache = new Map<string, Buffer>();
  constructor(id: number, name: string, description: string, isPrivate: boolean) {
    this.id = id; this.name = name; this.description = description; this.isPrivate = isPrivate;
    this.createdSeq = nextSeq();
  }
  get path(): string { return `/api/v3/repos/${this.owner}/${this.name}`; }
  get fullName(): string { return `${this.owner}/${this.name}`; }
  tip(branch = this.defaultBranch): string | null {
    return this.refs.get(`refs/heads/${branch}`) ?? null;
  }
  invalidate(): void { this.packCache.clear(); }
}
const repos = new Map<string, Repo>(); // "owner/name" -> Repo
let repoIdSeq = 4999;
let issueIdSeq = 99999;
let commentIdSeq = 199999;
let labelIdSeq = 299999;
let pullIdSeq = 89999;
function getRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER.login) return undefined;
  return repos.get(`${owner}/${name}`);
}
function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.id, name: r.name, full_name: r.fullName,
    owner: { login: r.owner, id: VIEWER.id, type: 'User' },
    private: r.isPrivate, description: r.description, fork: false,
    html_url: `https://github.com/${r.fullName}`, url: `https://api.github.com/repos/${r.fullName}`,
    default_branch: r.defaultBranch, has_issues: true, has_projects: true, has_wiki: true,
    created_at: isoForCached(r.createdSeq), updated_at: isoForCached(r.createdSeq), pushed_at: isoForCached(r.createdSeq),
    open_issues_count: r.issues.filter((i) => i.state === 'open').length,
  };
}
function issueJson(r: Repo, i: IssueRec): Record<string, unknown> {
  return {
    id: i.id, number: i.number, title: i.title, body: i.body, state: i.state,
    labels: i.labels.map((name) => ({ name, color: r.labels.get(name)?.color ?? 'ededed' })),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    assignee: null, assignees: [], comments: i.comments.length,
    created_at: isoForCached(i.createdSeq), updated_at: isoForCached(i.updatedSeq),
    html_url: `https://github.com/${r.fullName}/issues/${i.number}`,
    url: `https://api.github.com/repos/${r.fullName}/issues/${i.number}`,
  };
}
function issueJsonBuf(r: Repo, i: IssueRec): Buffer {
  const c = i.jsonCache;
  if (c && c.updatedSeq === i.updatedSeq && c.comments === i.comments.length) return c.buf;
  const buf = Buffer.from(JSON.stringify(issueJson(r, i)), 'utf8');
  i.jsonCache = { buf, updatedSeq: i.updatedSeq, comments: i.comments.length };
  return buf;
}
function pullJson(r: Repo, p: PullRec): Record<string, unknown> {
  return {
    id: p.id, number: p.number, title: p.title, body: p.body, state: p.state,
    merged: p.merged, mergeable: true, mergeable_state: 'clean',
    merged_at: p.mergedAt, merge_commit_sha: p.mergeCommitSha,
    head: { ref: p.headRef, sha: p.headSha, label: `${VIEWER.login}:${p.headRef}` },
    base: { ref: p.baseRef, sha: p.baseSha, label: `${VIEWER.login}:${p.baseRef}` },
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: isoForCached(p.createdSeq), updated_at: isoForCached(p.updatedSeq),
    html_url: `https://github.com/${r.fullName}/pull/${p.number}`,
    url: `https://api.github.com/repos/${r.fullName}/pulls/${p.number}`,
  };
}
function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}
function parseGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = decoded.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Fetch pack computation (v2 + v0 share this)
// ---------------------------------------------------------------------------
interface FetchPlan {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
  wantedRefs: Array<{ oid: string; ref: string }>;
}
function peelToCommit(repo: Repo, oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 8; i++) {
    const obj = repo.objects.get(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') { cur = parseTag(obj.data).target; continue; }
    return null;
  }
  return null;
}
function computeFetch(repo: Repo, wants: string[], haves: string[], shallowIn: string[], depth: number | null): FetchPlan {
  const haveSet = new Set(haves);
  const shallowSet = new Set(shallowIn);
  const wantedRefs: Array<{ oid: string; ref: string }> = [];
  for (const [ref, oid] of repo.refs) {
    for (const w of wants) if (oid === w) wantedRefs.push({ oid: w, ref });
  }
  // BFS over commits from wants.
  const gen = new Map<string, number>();
  const queue: string[] = [];
  for (const w of wants) {
    const c = peelToCommit(repo, w);
    if (c && !gen.has(c)) { gen.set(c, 0); queue.push(c); }
  }
  const selected = new Set<string>(); // commits to include (before have-exclusion)
  const visited = new Set<string>();
  const boundary = new Set<string>();
  while (queue.length) {
    const oid = queue.shift()!;
    const g = gen.get(oid)!;
    if (depth !== null && g >= depth) continue;
    visited.add(oid);
    if (shallowSet.has(oid) && g > 0) continue; // already-held boundary: do not cross
    selected.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (depth !== null && g === depth - 1) {
      if (parents.length) boundary.add(oid);
      continue;
    }
    if (depth === null && shallowSet.has(oid) && g > 0) continue;
    for (const p of parents) {
      if (!gen.has(p)) { gen.set(p, g + 1); queue.push(p); }
    }
  }
  // Shallow/unshallow reporting.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const b of boundary) shallow.push(b);
    for (const s of shallowIn) {
      const obj = repo.objects.get(s);
      if (!obj || obj.type !== 'commit') continue;
      if (!selected.has(s)) continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.every((p) => selected.has(p))) unshallow.push(s);
    }
  } else if (shallowIn.length) {
    for (const s of shallowIn) {
      if (!visited.has(s)) continue;
      const obj = repo.objects.get(s);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.length && parents.every((p) => selected.has(p))) unshallow.push(s);
      else shallow.push(s);
    }
  }
  // Collect objects: selected commits (minus haves) + their full tree closures,
  // skipping the tree closure of any commit the client already has. For a plain
  // (non-shallow) fetch, also skip every object reachable from a have-commit:
  // blobs and trees shared with the new tip are already held.
  const held = new Set<string>();
  if (depth === null) {
    for (const h of haves) {
      const hc = peelToCommit(repo, h);
      if (!hc) continue;
      for (const c of commitWalk(repo, hc, 100000)) {
        held.add(c);
        const co = repo.objects.get(c);
        if (!co || co.type !== 'commit') continue;
        const addTree = (treeOid: string): void => {
          if (held.has(treeOid)) return;
          held.add(treeOid);
          const t = repo.objects.get(treeOid);
          if (!t || t.type !== 'tree') return;
          for (const e of parseTree(t.data)) {
            if (e.mode === '40000') addTree(e.oid);
            else held.add(e.oid);
          }
        };
        addTree(parseCommit(co.data).tree);
      }
    }
  }
  const include = new Map<string, GitObj>();
  const addObj = (oid: string): void => {
    if (include.has(oid) || held.has(oid)) return;
    const obj = repo.objects.get(oid);
    if (!obj) return;
    include.set(oid, obj);
  };
  for (const oid of selected) {
    if (haveSet.has(oid)) continue; // client already holds this commit and its tree
    addObj(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const collectTree = (treeOid: string): void => {
      addObj(treeOid);
      const t = repo.objects.get(treeOid);
      if (!t || t.type !== 'tree') return;
      for (const e of parseTree(t.data)) {
        if (e.mode === '40000') collectTree(e.oid);
        else addObj(e.oid);
      }
    };
    collectTree(parseCommit(obj.data).tree);
  }
  // A want that names a tag object must carry the tag object itself (clone of a
  // tag ref), not just the commit it peels to.
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (obj && obj.type === 'tag') addObj(w);
  }
  const pack = writePack([...include.values()]);
  return { pack, shallow, unshallow, wantedRefs };
}
function cachedFetch(repo: Repo, wants: string[], haves: string[], shallowIn: string[], depth: number | null): FetchPlan {
  if (haves.length === 0 && shallowIn.length === 0 && (depth === null || depth === 1)) {
    const key = `${wants.slice().sort().join(',')}|${depth ?? ''}`;
    const hit = repo.packCache.get(key);
    if (hit) {
      const wantedRefs: Array<{ oid: string; ref: string }> = [];
      for (const [ref, oid] of repo.refs) for (const w of wants) if (oid === w) wantedRefs.push({ oid: w, ref });
      const shallow = depth === 1 ? wants.filter((w) => {
        const c = peelToCommit(repo, w);
        const o = c ? repo.objects.get(c) : undefined;
        return !!o && o.type === 'commit' && parseCommit(o.data).parents.length > 0;
      }) : [];
      return { pack: hit, shallow, unshallow: [], wantedRefs };
    }
    const plan = computeFetch(repo, wants, haves, shallowIn, depth);
    repo.packCache.set(key, plan.pack);
    return plan;
  }
  return computeFetch(repo, wants, haves, shallowIn, depth);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
function authed(req: http.IncomingMessage): boolean {
  if (!TOKEN) return true; // local dev without a token set
  const h = req.headers.authorization ?? '';
  return h === `Bearer ${TOKEN}` || h === `token ${TOKEN}`;
}
let reqSeq = 0;
function jsonHeaders(): Record<string, string> {
  reqSeq += 1;
  return { 'content-type': 'application/json', 'x-github-request-id': `req-${reqSeq}` };
}
function sendJson(res: http.ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  const headers = { ...jsonHeaders(), ...(extra ?? {}) };
  const data = body === null ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, headers);
  res.end(data);
}
function sendJsonBuf(res: http.ServerResponse, status: number, buf: Buffer): void {
  // Same headers as sendJson (fresh x-github-request-id per response),
  // but the body bytes are prebuilt (issue JSON cache) — no stringify.
  res.writeHead(status, jsonHeaders());
  res.end(buf);
}
function sendErr(res: http.ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}
function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJsonBody(req: http.IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; raw: string }> {
  const buf = await readBody(req);
  const raw = buf.toString('utf8');
  if (!raw.trim()) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(raw) }; } catch { return { ok: false, raw }; }
}
function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function pageParams(url: URL): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(url.searchParams.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}
function paginate<T>(items: T[], url: URL, req: http.IncomingMessage, res: http.ServerResponse): T[] {
  const { page, perPage } = pageParams(url);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage < items.length) {
    const host = req.headers.host ?? '127.0.0.1';
    const next = new URL(url.toString());
    next.searchParams.set('page', String(page + 1));
    next.searchParams.set('per_page', String(perPage));
    const last = new URL(url.toString());
    last.searchParams.set('page', String(Math.ceil(items.length / perPage)));
    last.searchParams.set('per_page', String(perPage));
    const base = `http://${host}${url.pathname}`;
    const link = `<${base}?${next.searchParams.toString()}>; rel="next", <${base}?${last.searchParams.toString()}>; rel="last"`;
    res.setHeader('Link', link);
  }
  return slice;
}
function parsePath(p: string): string[] {
  // decodeURIComponent is a no-op (and never throws) for segments without '%',
  // and hot paths (issue reads) are all plain ASCII segments.
  return p.split('/').filter((s) => s.length > 0).map((s) => { if (!s.includes('%')) return s; try { return decodeURIComponent(s); } catch { return s; } });
}

// ---------------------------------------------------------------------------
// Contents (REST): commits built on the default branch
// ---------------------------------------------------------------------------
function makeApiCommit(repo: Repo, message: string, flat: Map<string, { mode: string; oid: string }>, branch: string): string {
  const treeOid = buildTreeFromFlat(repo, flat);
  const parent = repo.tip(branch);
  const n = nextSeq();
  const ts = BASE_EPOCH + n;
  const ident = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
  const head = `tree ${treeOid}\n${parent ? `parent ${parent}\n` : ''}author ${ident}\ncommitter ${ident}\n\n${message}\n`;
  const data = Buffer.from(head, 'utf8');
  const oid = objectId('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  repo.refs.set(`refs/heads/${branch}`, oid);
  repo.invalidate();
  return oid;
}
function commitIso(repo: Repo, oid: string): string {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return isoFor(1);
  const c = parseCommit(obj.data);
  const m = c.authorLine.match(/ (\d+) [+-]\d{4}$/);
  if (m) return new Date(parseInt(m[1], 10) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return isoFor(1);
}
function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const obj = repo.objects.get(oid);
  const c = obj ? parseCommit(obj.data) : null;
  const author = c?.authorLine.replace(/ \d+ [+-]\d{4}$/, '') ?? '';
  const am = author.match(/^(.*) <(.*)>$/);
  return {
    sha: oid,
    commit: {
      message: c?.message.trim() ?? '',
      author: { name: am?.[1] ?? VIEWER.name, email: am?.[2] ?? VIEWER.email, date: commitIso(repo, oid) },
      committer: { name: am?.[1] ?? VIEWER.name, email: am?.[2] ?? VIEWER.email, date: commitIso(repo, oid) },
    },
    parents: (c?.parents ?? []).map((p) => ({ sha: p })),
    author: { login: VIEWER.login, id: VIEWER.id },
    committer: { login: VIEWER.login, id: VIEWER.id },
  };
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------
async function handleRest(req: http.IncomingMessage, res: http.ServerResponse, url: URL, parts: string[]): Promise<boolean> {
  // parts[0] === 'api', parts[1] === 'v3'
  const seg = parts.slice(2);
  if (!authed(req)) { sendErr(res, 401, 'Requires authentication'); return true; }
  const method = req.method ?? 'GET';
  // GET /api/v3/
  if (seg.length === 0) {
    if (method !== 'GET') { sendErr(res, 404, 'Not Found'); return true; }
    sendJson(res, 200, { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (seg[0] === 'meta' && seg.length === 1) {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true, github_services_sha: '0000000000000000000000000000000000000000' });
    return true;
  }
  if (seg[0] === 'user' && seg.length === 1) {
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
    return true;
  }
  if (seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return true; }
      const body = isRec(parsed.value) ? parsed.value : {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) { sendErr(res, 422, 'name is required and must be a valid repository name'); return true; }
      if (repos.has(`${VIEWER.login}/${name}`)) { sendErr(res, 422, 'Repository already exists'); return true; }
      const repo = new Repo(++repoIdSeq, name, typeof body.description === 'string' ? body.description : '', body.private === true);
      repos.set(repo.fullName, repo);
      sendJson(res, 201, repoJson(repo));
      return true;
    }
    if (method === 'GET') {
      const all = [...repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
      const slice = paginate(all, url, req, res);
      sendJson(res, 200, slice.map(repoJson));
      return true;
    }
    sendErr(res, 404, 'Not Found');
    return true;
  }
  if (seg[0] === 'repos' && seg.length >= 3) {
    const owner = seg[1];
    const name = seg[2];
    const repo = getRepo(owner, name);
    const rest = seg.slice(3);
    if (!repo) { sendErr(res, 404, 'Not Found'); return true; }
    if (rest.length === 0) {
      if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return true; }
      if (method === 'PATCH') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return true; }
        const body = isRec(parsed.value) ? parsed.value : {};
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        if (typeof body.name === 'string' && /^[A-Za-z0-9._-]+$/.test(body.name) && body.name !== repo.name) {
          repos.delete(repo.fullName);
          repo.name = body.name;
          repos.set(repo.fullName, repo);
        }
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        repos.delete(repo.fullName);
        res.writeHead(204, jsonHeaders());
        res.end();
        return true;
      }
      sendErr(res, 404, 'Not Found');
      return true;
    }
    // branches
    if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
      const out = [...repo.refs.entries()]
        .filter(([k]) => k.startsWith('refs/heads/'))
        .map(([k, oid]) => ({ name: k.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }));
      sendJson(res, 200, out);
      return true;
    }
    // commits
    if (rest[0] === 'commits' && method === 'GET') {
      if (rest.length === 2) {
        const obj = repo.objects.get(rest[1]);
        if (!obj || obj.type !== 'commit') { sendErr(res, 404, 'Not Found'); return true; }
        sendJson(res, 200, commitJson(repo, rest[1]));
        return true;
      }
      const ref = url.searchParams.get('sha') ?? repo.defaultBranch;
      let tip = repo.refs.get(`refs/heads/${ref}`) ?? repo.objects.has(ref) ? (repo.refs.get(`refs/heads/${ref}`) ?? ref) : null;
      if (!tip) { sendJson(res, 200, []); return true; }
      const list = commitWalk(repo, tip, 100).map((oid) => commitJson(repo, oid));
      const slice = paginate(list, url, req, res);
      sendJson(res, 200, slice);
      return true;
    }
    // contents
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${ref}`) ?? (repo.objects.has(ref) ? ref : null);
      if (method === 'GET') {
        if (!tip) { sendErr(res, 404, 'Not Found'); return true; }
        const tipObj = repo.objects.get(tip);
        if (!tipObj || tipObj.type !== 'commit') { sendErr(res, 404, 'Not Found'); return true; }
        const flat = new Map<string, { mode: string; oid: string }>();
        flattenTree(repo, parseCommit(tipObj.data).tree, '', flat);
        if (!path) {
          // root listing
          const seen = new Map<string, { type: string; name: string; path: string; sha: string }>();
          for (const [p, ent] of flat) {
            const first = p.split('/')[0];
            if (!seen.has(first)) {
              const isDir = p.includes('/');
              seen.set(first, { type: isDir ? 'dir' : 'file', name: first, path: first, sha: isDir ? '' : ent.oid });
            }
          }
          const items = [...seen.values()].map((e) => {
            if (e.type === 'dir') {
              const dirFlat = new Map<string, { mode: string; oid: string }>();
              for (const [p, ent] of flat) if (p.startsWith(e.path + '/')) dirFlat.set(p.slice(e.path.length + 1), ent);
              return { type: 'dir', name: e.name, path: e.path, sha: buildTreeFromFlat(repo, dirFlat), size: 0, url: '', download_url: null };
            }
            const blob = repo.objects.get(e.sha);
            return { type: 'file', name: e.name, path: e.path, sha: e.sha, size: blob?.data.length ?? 0, url: '', download_url: null };
          });
          sendJson(res, 200, items);
          return true;
        }
        const ent = flat.get(path);
        if (ent) {
          const blob = repo.objects.get(ent.oid);
          sendJson(res, 200, {
            type: 'file', encoding: 'base64', size: blob?.data.length ?? 0, name: path.split('/').pop(),
            path, sha: ent.oid, content: (blob?.data ?? Buffer.alloc(0)).toString('base64'),
            url: '', download_url: null,
          });
          return true;
        }
        // directory?
        const prefix = path + '/';
        const children = [...flat.keys()].filter((p) => p.startsWith(prefix));
        if (children.length) {
          const seen = new Map<string, { type: string; name: string; path: string; sha: string }>();
          for (const p of children) {
            const restPath = p.slice(prefix.length);
            const first = restPath.split('/')[0];
            if (!seen.has(first)) {
              const isDir = restPath.includes('/');
              seen.set(first, { type: isDir ? 'dir' : 'file', name: first, path: `${path}/${first}`, sha: isDir ? '' : flat.get(p)!.oid });
            }
          }
          const items = [...seen.values()].map((e) => {
            if (e.type === 'dir') {
              const dirFlat = new Map<string, { mode: string; oid: string }>();
              for (const [p, en] of flat) if (p.startsWith(e.path + '/')) dirFlat.set(p.slice(e.path.length + 1), en);
              return { type: 'dir', name: e.name, path: e.path, sha: buildTreeFromFlat(repo, dirFlat), size: 0, url: '', download_url: null };
            }
            const blob = repo.objects.get(e.sha);
            return { type: 'file', name: e.name, path: e.path, sha: e.sha, size: blob?.data.length ?? 0, url: '', download_url: null };
          });
          sendJson(res, 200, items);
          return true;
        }
        sendErr(res, 404, 'Not Found');
        return true;
      }
      if (method === 'PUT' || method === 'DELETE') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return true; }
        const body = isRec(parsed.value) ? parsed.value : {};
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const curTip = repo.tip(branch);
        const curFlat = new Map<string, { mode: string; oid: string }>();
        if (curTip) {
          const o = repo.objects.get(curTip);
          if (o && o.type === 'commit') flattenTree(repo, parseCommit(o.data).tree, '', curFlat);
        }
        if (method === 'PUT') {
          if (typeof body.content !== 'string') { sendErr(res, 422, 'content is required'); return true; }
          const content = Buffer.from(body.content, 'base64');
          const blobOid = objectId('blob', content);
          repo.objects.set(blobOid, { type: 'blob', data: content });
          const existing = curFlat.get(path);
          if (typeof body.sha === 'string') {
            if (!existing || existing.oid !== body.sha) { sendErr(res, 409, 'sha does not match the current file'); return true; }
          }
          curFlat.set(path, { mode: '100644', oid: blobOid });
          const message = typeof body.message === 'string' ? body.message : `Update ${path}`;
          const commitSha = makeApiCommit(repo, message, curFlat, branch);
          const status = existing ? 200 : 201;
          sendJson(res, status, {
            content: { type: 'file', encoding: 'base64', size: content.length, name: path.split('/').pop(), path, sha: blobOid, content: content.toString('base64') },
            commit: { sha: commitSha, message },
          });
          return true;
        }
        // DELETE
        if (!curFlat.has(path)) { sendErr(res, 404, 'Not Found'); return true; }
        if (typeof body.sha === 'string' && curFlat.get(path)!.oid !== body.sha) { sendErr(res, 409, 'sha does not match the current file'); return true; }
        curFlat.delete(path);
        const message = typeof body.message === 'string' ? body.message : `Delete ${path}`;
        const commitSha = makeApiCommit(repo, message, curFlat, branch);
        sendJson(res, 200, { commit: { sha: commitSha, message } });
        return true;
      }
      sendErr(res, 404, 'Not Found');
      return true;
    }
    // git refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return true; }
        const body = isRec(parsed.value) ? parsed.value : {};
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !repo.objects.has(sha)) { sendErr(res, 422, 'ref and sha are required and sha must exist'); return true; }
        if (repo.refs.has(ref)) { sendErr(res, 422, 'Reference already exists'); return true; }
        repo.refs.set(ref, sha);
        repo.invalidate();
        sendJson(res, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' }, url: '' });
        return true;
      }
      if (method === 'GET' && rest.length >= 3) {
        const ref = `refs/${rest.slice(2).join('/')}`;
        const oid = repo.refs.get(ref);
        if (!oid) { sendErr(res, 404, 'Not Found'); return true; }
        sendJson(res, 200, { ref, object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit' }, url: '' });
        return true;
      }
      sendErr(res, 404, 'Not Found');
      return true;
    }
    // labels
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ id: l.id, name: l.name, color: l.color, description: '' })));
        return true;
      }
      if (method === 'POST' && rest.length === 1) {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return true; }
        const body = isRec(parsed.value) ? parsed.value : {};
        const name = typeof body.name === 'string' ? body.name : '';
        if (!name) { sendErr(res, 422, 'name is required'); return true; }
        if (repo.labels.has(name)) { sendErr(res, 422, 'Label already exists'); return true; }
        const label = { name, color: typeof body.color === 'string' ? body.color : 'ededed', id: ++labelIdSeq };
        repo.labels.set(name, label);
        sendJson(res, 201, { id: label.id, name, color: label.color, description: '' });
        return true;
      }
      sendErr(res, 404, 'Not Found');
      return true;
    }
    // issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          let list = repo.issues;
          if (state !== 'all') list = list.filter((i) => i.state === state);
          const sort = url.searchParams.get('sort') ?? 'created';
          const dir = url.searchParams.get('direction') ?? 'desc';
          if (sort === 'created') list = [...list].sort((a, b) => dir === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq);
          const slice = paginate(list, url, req, res);
          sendJson(res, 200, slice.map((i) => issueJson(repo, i)));
          return true;
        }
        if (method === 'POST') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return true; }
          const body = isRec(parsed.value) ? parsed.value : {};
          const title = typeof body.title === 'string' ? body.title : '';
          if (!title) { sendErr(res, 422, 'title is required'); return true; }
          const labels: string[] = Array.isArray(body.labels) ? body.labels.filter((x): x is string => typeof x === 'string') : [];
          for (const l of labels) if (!repo.labels.has(l)) { sendErr(res, 422, `Label does not exist: ${l}`); return true; }
          const n = nextSeq();
          const issue: IssueRec = {
            number: repo.issues.length + 1, id: ++issueIdSeq, title,
            body: typeof body.body === 'string' ? body.body : '', state: 'open', labels,
            createdSeq: n, updatedSeq: n, comments: [], jsonCache: null,
          };
          repo.issues.push(issue);
          repo.issuesByNum.set(issue.number, issue);
          sendJson(res, 201, issueJson(repo, issue));
          return true;
        }
        sendErr(res, 404, 'Not Found');
        return true;
      }
      const num = parseInt(rest[1], 10);
      const issue = repo.issuesByNum.get(num);
      if (rest.length === 2) {
        if (!issue) { sendErr(res, 404, 'Not Found'); return true; }
        if (method === 'GET') { sendJsonBuf(res, 200, issueJsonBuf(repo, issue)); return true; }
        if (method === 'PATCH') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return true; }
          const body = isRec(parsed.value) ? parsed.value : {};
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (Array.isArray(body.labels)) {
            const labels = body.labels.filter((x): x is string => typeof x === 'string');
            for (const l of labels) if (!repo.labels.has(l)) { sendErr(res, 422, `Label does not exist: ${l}`); return true; }
            issue.labels = labels;
          }
          issue.updatedSeq = nextSeq();
          sendJsonBuf(res, 200, issueJsonBuf(repo, issue));
          return true;
        }
        sendErr(res, 404, 'Not Found');
        return true;
      }
      if (rest[2] === 'comments') {
        if (!issue) { sendErr(res, 404, 'Not Found'); return true; }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: isoForCached(c.createdSeq), updated_at: isoForCached(c.createdSeq) })));
          return true;
        }
        if (method === 'POST') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return true; }
          const body = isRec(parsed.value) ? parsed.value : {};
          if (typeof body.body !== 'string' || !body.body) { sendErr(res, 422, 'body is required'); return true; }
          const c = { id: ++commentIdSeq, body: body.body, createdSeq: nextSeq() };
          issue.comments.push(c);
          issue.updatedSeq = nextSeq();
          sendJson(res, 201, { id: c.id, body: c.body, user: { login: VIEWER.login, id: VIEWER.id }, created_at: isoForCached(c.createdSeq), updated_at: isoForCached(c.createdSeq) });
          return true;
        }
        sendErr(res, 404, 'Not Found');
        return true;
      }
      sendErr(res, 404, 'Not Found');
      return true;
    }
    // pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          let list = repo.pulls;
          if (state !== 'all') list = list.filter((p) => p.state === state);
          const slice = paginate(list, url, req, res);
          sendJson(res, 200, slice.map((p) => pullJson(repo, p)));
          return true;
        }
        if (method === 'POST') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return true; }
          const body = isRec(parsed.value) ? parsed.value : {};
          const title = typeof body.title === 'string' ? body.title : '';
          const headRaw = typeof body.head === 'string' ? body.head : '';
          const baseRaw = typeof body.base === 'string' ? body.base : '';
          const head = headRaw.includes(':') ? headRaw.split(':').slice(1).join(':') : headRaw;
          const base = baseRaw.includes(':') ? baseRaw.split(':').slice(1).join(':') : baseRaw;
          if (!title || !head || !base) { sendErr(res, 422, 'title, head and base are required'); return true; }
          const headSha = repo.tip(head);
          const baseSha = repo.tip(base);
          if (!headSha || !baseSha) { sendErr(res, 422, 'head or base branch does not exist'); return true; }
          const n = nextSeq();
          const pull: PullRec = {
            number: repo.pulls.length + 1, id: ++pullIdSeq, title,
            body: typeof body.body === 'string' ? body.body : '', state: 'open',
            merged: false, mergedAt: null, mergeCommitSha: null,
            headRef: head, headSha, baseRef: base, baseSha, createdSeq: n, updatedSeq: n,
          };
          repo.pulls.push(pull);
          repo.pullsByNum.set(pull.number, pull);
          sendJson(res, 201, pullJson(repo, pull));
          return true;
        }
        sendErr(res, 404, 'Not Found');
        return true;
      }
      const num = parseInt(rest[1], 10);
      const pull = repo.pullsByNum.get(num);
      if (rest.length === 2) {
        if (!pull) { sendErr(res, 404, 'Not Found'); return true; }
        if (method === 'GET') { sendJson(res, 200, pullJson(repo, pull)); return true; }
        if (method === 'PATCH') {
          const parsed = await readJsonBody(req);
          if (!parsed.ok) { sendErr(res, 400, 'Problems parsing JSON'); return true; }
          const body = isRec(parsed.value) ? parsed.value : {};
          if (body.state === 'open' || body.state === 'closed') pull.state = body.state;
          if (typeof body.title === 'string') pull.title = body.title;
          if (typeof body.body === 'string') pull.body = body.body;
          pull.updatedSeq = nextSeq();
          sendJson(res, 200, pullJson(repo, pull));
          return true;
        }
        sendErr(res, 404, 'Not Found');
        return true;
      }
      if (rest[2] === 'files' && method === 'GET') {
        if (!pull) { sendErr(res, 404, 'Not Found'); return true; }
        sendJson(res, 200, pullFiles(repo, pull));
        return true;
      }
      if (rest[2] === 'merge' && method === 'PUT') {
        if (!pull) { sendErr(res, 404, 'Not Found'); return true; }
        const result = mergePull(repo, pull);
        if ('error' in result) { sendErr(res, result.status, result.error); return true; }
        sendJson(res, 200, { sha: result.sha, merged: true, message: `Merge pull request #${pull.number} from ${pull.headRef}` });
        return true;
      }
      sendErr(res, 404, 'Not Found');
      return true;
    }
  }
  sendErr(res, 404, 'Not Found');
  return true;
}
function pullFiles(repo: Repo, pull: PullRec): Array<Record<string, unknown>> {
  const baseTip = repo.tip(pull.baseRef);
  const headTip = repo.tip(pull.headRef);
  const baseFlat = new Map<string, { mode: string; oid: string }>();
  const headFlat = new Map<string, { mode: string; oid: string }>();
  const baseCommitOid = pull.baseSha;
  const baseObj = repo.objects.get(baseCommitOid);
  if (baseObj && baseObj.type === 'commit') flattenTree(repo, parseCommit(baseObj.data).tree, '', baseFlat);
  if (headTip) {
    const h = repo.objects.get(headTip);
    if (h && h.type === 'commit') flattenTree(repo, parseCommit(h.data).tree, '', headFlat);
  }
  void baseTip;
  const out: Array<Record<string, unknown>> = [];
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    if (b && h && b.oid === h.oid) continue;
    let status = 'modified';
    let additions = 0;
    let deletions = 0;
    if (!b && h) {
      status = 'added';
      const blob = repo.objects.get(h.oid);
      additions = blob ? (blob.data.toString('utf8').split('\n').length - 1) + (blob.data.length ? 1 : 0) : 0;
    } else if (b && !h) {
      status = 'removed';
      const blob = repo.objects.get(b.oid);
      deletions = blob ? (blob.data.toString('utf8').split('\n').length - 1) + (blob.data.length ? 1 : 0) : 0;
    } else if (b && h) {
      status = 'modified';
      const bb = repo.objects.get(b.oid)?.data.toString('utf8') ?? '';
      const hb = repo.objects.get(h.oid)?.data.toString('utf8') ?? '';
      const bl = bb.split('\n');
      const hl = hb.split('\n');
      const bSet = new Set(bl);
      const hSet = new Set(hl);
      additions = hl.filter((l) => !bSet.has(l)).length;
      deletions = bl.filter((l) => !hSet.has(l)).length;
      if (additions === 0 && deletions === 0) { additions = 1; }
    }
    out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}
function mergePull(repo: Repo, pull: PullRec): { sha: string } | { error: string; status: number } {
  if (pull.merged) return { error: 'Pull request already merged', status: 405 };
  const baseTip = repo.tip(pull.baseRef);
  const headTip = repo.tip(pull.headRef);
  if (!baseTip || !headTip) return { error: 'Not Found', status: 404 };
  const mergeBase = findMergeBase(repo, baseTip, headTip) ?? pull.baseSha;
  const baseFlat = new Map<string, { mode: string; oid: string }>();
  const headFlat = new Map<string, { mode: string; oid: string }>();
  const curFlat = new Map<string, { mode: string; oid: string }>();
  const mbObj = repo.objects.get(mergeBase);
  if (mbObj && mbObj.type === 'commit') flattenTree(repo, parseCommit(mbObj.data).tree, '', baseFlat);
  const hObj = repo.objects.get(headTip);
  if (hObj && hObj.type === 'commit') flattenTree(repo, parseCommit(hObj.data).tree, '', headFlat);
  const cObj = repo.objects.get(baseTip);
  if (cObj && cObj.type === 'commit') flattenTree(repo, parseCommit(cObj.data).tree, '', curFlat);
  // Conflict: a path changed on both sides relative to the merge base, to different content.
  for (const [path, hEnt] of headFlat) {
    const bEnt = baseFlat.get(path);
    if (bEnt && bEnt.oid !== hEnt.oid) {
      const cEnt = curFlat.get(path);
      if (cEnt && cEnt.oid !== bEnt.oid && cEnt.oid !== hEnt.oid) {
        return { error: 'Merge conflict', status: 405 };
      }
    }
  }
  for (const [path, bEnt] of baseFlat) {
    if (!headFlat.has(path)) {
      const cEnt = curFlat.get(path);
      if (cEnt && cEnt.oid !== bEnt.oid) return { error: 'Merge conflict', status: 405 };
    }
  }
  const merged = new Map(curFlat);
  for (const [path, hEnt] of headFlat) merged.set(path, hEnt);
  for (const path of baseFlat.keys()) if (!headFlat.has(path)) merged.delete(path);
  const n = nextSeq();
  const treeOid = buildTreeFromFlat(repo, merged);
  const ts = BASE_EPOCH + n;
  const ident = `${VIEWER.name} <${VIEWER.email}> ${ts} +0000`;
  const head = `tree ${treeOid}\nparent ${baseTip}\nparent ${headTip}\nauthor ${ident}\ncommitter ${ident}\n\n${pull.title}\n`;
  const data = Buffer.from(head, 'utf8');
  const oid = objectId('commit', data);
  repo.objects.set(oid, { type: 'commit', data });
  repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
  repo.invalidate();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoFor(n);
  pull.mergeCommitSha = oid;
  pull.updatedSeq = n;
  return { sha: oid };
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------
function sidebandWrap(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < data.length; i += 60000) {
    const chunk = data.subarray(i, Math.min(data.length, i + 60000));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}
function refLinesV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-receive-pack'
    ? 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=' + AGENT
    : `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k multi_ack thin-pack ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [];
  const headOid = repo.tip(repo.defaultBranch) ?? ZERO_OID;
  parts.push(pktLine(`# service=${service}\n`));
  parts.push(pktFlush());
  parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
  const refs = [...repo.refs.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
  for (const [name, oid] of refs) {
    parts.push(pktLine(`${oid} ${name}\n`));
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const target = parseTag(obj.data).target;
      if (target) parts.push(pktLine(`${target} ${name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}
function advertisementV2(repo: Repo, service: 'git-upload-pack'): Buffer {
  const parts: Buffer[] = [
    pktLine(`# service=${service}\n`),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn peel symref\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('server-option\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ];
  return Buffer.concat(parts);
}
function handleInfoRefs(req: http.IncomingMessage, res: http.ServerResponse, repo: Repo, service: string): void {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('Invalid service');
    return;
  }
  const isV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  const body = service === 'git-receive-pack' ? refLinesV0(repo, service) : isV2 ? advertisementV2(repo, service) : refLinesV0(repo, service);
  const ctype = service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  res.writeHead(200, { 'content-type': ctype, 'cache-control': 'no-cache' });
  res.end(body);
}
function handleLsRefsV2(repo: Repo, args: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const a of args) {
    if (a === 'peel') peel = true;
    else if (a === 'symrefs') symrefs = true;
    else if (a.startsWith('ref-prefix ')) prefixes.push(a.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const headOid = repo.tip(repo.defaultBranch);
  if (!headOid) {
    if (keep('HEAD')) {
      let line = 'unborn HEAD';
      if (symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      parts.push(pktLine(line + '\n'));
    }
  } else {
    if (keep('HEAD')) {
      let line = `${headOid} HEAD`;
      if (symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
      parts.push(pktLine(line + '\n'));
    }
  }
  const refs = [...repo.refs.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1);
  for (const [name, oid] of refs) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const target = parseTag(obj.data).target;
        if (target) line += ` peeled:${target}`;
      }
    }
    parts.push(pktLine(line + '\n'));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}
function handleFetchV2(repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const a of args) {
    if (a.startsWith('want ')) wants.push(a.slice(5).trim());
    else if (a.startsWith('have ')) haves.push(a.slice(5).trim());
    else if (a.startsWith('shallow ')) shallow.push(a.slice(8).trim());
    else if (a.startsWith('deepen ')) depth = parseInt(a.slice(7).trim(), 10);
  }
  const plan = cachedFetch(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (haves.length === 0) parts.push(pktLine('NAK\n'));
  else {
    // Acknowledge a common commit when the client already holds a want.
    const common = wants.find((w) => haves.includes(w));
    if (common) { parts.push(pktLine(`ACK ${common}\n`)); parts.push(pktLine('ready\n')); }
    else parts.push(pktLine('NAK\n'));
  }
  parts.push(pktFlush());
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
    for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
    parts.push(pktFlush());
  }
  if (plan.wantedRefs.length) {
    parts.push(pktLine('wanted-refs\n'));
    for (const wr of plan.wantedRefs) parts.push(pktLine(`${wr.oid} ${wr.ref}\n`));
    parts.push(pktFlush());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandWrap(plan.pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}
function handleFetchV0(repo: Repo, body: Buffer, packets?: Pkt[]): Buffer {
  const pk = packets ?? decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  let depth: number | null = null;
  let sawFlush = false;
  for (const p of pk) {
    if (p.kind === 'flush') { sawFlush = true; continue; }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    if (clean.startsWith('want ')) wants.push(clean.slice(5).trim());
    else if (clean.startsWith('have ')) haves.push(clean.slice(5).trim());
    else if (clean.startsWith('deepen ')) depth = parseInt(clean.slice(7).trim(), 10);
  }
  void sawFlush;
  const plan = computeFetch(repo, wants, haves, [], depth);
  const parts: Buffer[] = [pktLine('NAK\n'), sidebandWrap(plan.pack), pktFlush()];
  return Buffer.concat(parts);
}
function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  // Find the first flush packet: the command list is before it, pack bytes after.
  // Only decode the command region as pkt-lines (never walk the pack bytes).
  let packStart = -1;
  let pos = 0;
  const raw = body;
  while (pos + 4 <= raw.length) {
    const len = parseInt(raw.subarray(pos, pos + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) { packStart = pos + 4; break; }
    pos += len;
  }
  const packets = packStart >= 0 ? decodePktLines(raw.subarray(0, packStart)) : decodePktLines(raw);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const p of packets) {
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    const m = clean.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/\S+)$/);
    if (m) commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let unpackOk = true;
  if (commands.some((c) => c.newOid !== ZERO_OID)) {
    if (packStart < 0 || packStart >= raw.length) {
      unpackOk = false;
      for (const c of commands) results.push({ ref: c.ref, ok: false, reason: 'unpacker error' });
    } else {
      let incoming: Map<string, GitObj>;
      try {
        incoming = readPack(raw.subarray(packStart), repo);
      } catch {
        unpackOk = false;
        incoming = new Map();
      }
      if (unpackOk) {
        for (const [oid, obj] of incoming) repo.objects.set(oid, obj);
        for (const c of commands) {
          const cur = repo.refs.get(c.ref);
          if (c.newOid === ZERO_OID) {
            if (!cur) { results.push({ ref: c.ref, ok: false, reason: 'no such ref' }); continue; }
            if (c.oldOid !== ZERO_OID && c.oldOid !== cur) { results.push({ ref: c.ref, ok: false, reason: 'old value does not match' }); continue; }
            repo.refs.delete(c.ref);
            results.push({ ref: c.ref, ok: true, reason: '' });
            continue;
          }
          if (!repo.objects.has(c.newOid)) { results.push({ ref: c.ref, ok: false, reason: 'object not found' }); continue; }
          if (c.oldOid === ZERO_OID) {
            if (cur) { results.push({ ref: c.ref, ok: false, reason: 'already exists' }); continue; }
          } else {
            if (cur !== c.oldOid) { results.push({ ref: c.ref, ok: false, reason: 'old value does not match' }); continue; }
            if (!isAncestor(repo, c.oldOid, c.newOid)) { results.push({ ref: c.ref, ok: false, reason: 'non-fast-forward' }); continue; }
          }
          repo.refs.set(c.ref, c.newOid);
          results.push({ ref: c.ref, ok: true, reason: '' });
        }
        repo.invalidate();
      } else {
        for (const c of commands) results.push({ ref: c.ref, ok: false, reason: 'unpacker error' });
      }
    }
  } else {
    for (const c of commands) {
      const cur = repo.refs.get(c.ref);
      if (!cur) { results.push({ ref: c.ref, ok: false, reason: 'no such ref' }); continue; }
      if (c.oldOid !== ZERO_OID && c.oldOid !== cur) { results.push({ ref: c.ref, ok: false, reason: 'old value does not match' }); continue; }
      repo.refs.delete(c.ref);
      results.push({ ref: c.ref, ok: true, reason: '' });
    }
    repo.invalidate();
  }
  const inner: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : 'unpack error\n')];
  for (const r of results) inner.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`));
  const innerBuf = Buffer.concat(inner);
  const body2 = Buffer.concat([sidebandWrap(innerBuf), pktFlush()]);
  return body2;
}
async function handleGit(req: http.IncomingMessage, res: http.ServerResponse, parts: string[], url: URL): Promise<boolean> {
  // /:owner/:repo/info/refs | /:owner/:repo/git-upload-pack | /:owner/:repo/git-receive-pack
  if (parts.length < 3) return false;
  const owner = parts[0];
  const name = parts[1];
  const tail = parts.slice(2).join('/');
  if (tail !== 'info/refs' && tail !== 'git-upload-pack' && tail !== 'git-receive-pack') return false;
  if (!authed(req)) {
    res.writeHead(401, { 'content-type': 'application/json', ...jsonHeaders() });
    res.end(JSON.stringify({ message: 'Requires authentication' }));
    return true;
  }
  const repo = getRepo(owner, name);
  if (!repo) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found');
    return true;
  }
  if (tail === 'info/refs') {
    handleInfoRefs(req, res, repo, url.searchParams.get('service') ?? '');
    return true;
  }
  const body = await readBody(req);
  if (tail === 'git-receive-pack') {
    const out = handleReceivePack(repo, body);
    res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' });
    res.end(out);
    return true;
  }
  // git-upload-pack: v2 command or v0 fetch (decode the body once and reuse it)
  const pk = decodePktLines(body);
  const isV2 = body.length > 4 && pk.some((p) => p.kind === 'data' && p.payload.toString('utf8').startsWith('command='));
  if (isV2) {
    const lines: string[] = [];
    let command = '';
    let inArgs = false;
    for (const p of pk) {
      if (p.kind === 'delim') { inArgs = true; continue; }
      if (p.kind === 'flush') break;
      if (p.kind !== 'data') continue;
      const text = p.payload.toString('utf8').replace(/\n$/, '');
      if (!inArgs) {
        if (text.startsWith('command=')) command = text.slice(8);
        continue;
      }
      lines.push(text);
    }
    let out: Buffer;
    if (command === 'ls-refs') out = handleLsRefsV2(repo, lines);
    else if (command === 'fetch') out = handleFetchV2(repo, lines);
    else {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('unknown command');
      return true;
    }
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
    res.end(out);
    return true;
  }
  const out = handleFetchV0(repo, body, pk);
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
  res.end(out);
  return true;
}

// ---------------------------------------------------------------------------
// GraphQL v4 (mini parser + executor for the documents gh / github-mcp-server send)
// ---------------------------------------------------------------------------
type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Map<string, GqlValue> };
interface GqlField {
  name: string; alias: string | null; args: Map<string, GqlValue>; selection: GqlField[] | null;
  fragmentType: string | null; isFragment: boolean;
}
function tokenizeGql(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '.' && src.slice(i, i + 3) === '...') { tokens.push('...'); i += 3; continue; }
    if ('{}()[]:!=$'.includes(c)) { tokens.push(c); i += 1; continue; }
    if (c === '"') {
      let j = i + 1;
      let s = '';
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\') { s += src[j + 1] ?? ''; j += 2; } else { s += src[j]; j += 1; } }
      tokens.push(JSON.stringify(s));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j])) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}
class GqlParser {
  tokens: string[];
  pos = 0;
  constructor(src: string) { this.tokens = tokenizeGql(src); }
  peek(): string | undefined { return this.tokens[this.pos]; }
  next(): string { return this.tokens[this.pos++]; }
  expect(t: string): void { if (this.next() !== t) throw new Error(`expected ${t}`); }
  parseValue(): GqlValue {
    const t = this.next();
    if (t === '$') return { kind: 'var', name: this.next() };
    if (t === '[') {
      const items: GqlValue[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (t === '{') {
      const fields = new Map<string, GqlValue>();
      while (this.peek() !== '}') { const name = this.next(); this.expect(':'); fields.set(name, this.parseValue()); }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t.startsWith('"')) return { kind: 'string', value: JSON.parse(t) as string };
    if (t === 'true') return { kind: 'bool', value: true };
    if (t === 'false') return { kind: 'bool', value: false };
    if (t === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(t)) return { kind: 'int', value: parseInt(t, 10) };
    if (/^-?[\d.]+$/.test(t)) return { kind: 'float', value: parseFloat(t) };
    return { kind: 'enum', value: t };
  }
  parseArgs(): Map<string, GqlValue> {
    const args = new Map<string, GqlValue>();
    if (this.peek() !== '(') return args;
    this.expect('(');
    while (this.peek() !== ')') { const name = this.next(); this.expect(':'); args.set(name, this.parseValue()); }
    this.expect(')');
    return args;
  }
  parseSelection(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        let fragmentType: string | null = null;
        if (this.peek() === 'on') { this.next(); fragmentType = this.next(); }
        else { this.next(); /* named fragment spread: not used by the checked documents */ }
        const sel = this.parseSelection();
        for (const f of sel) fields.push({ ...f, fragmentType });
        continue;
      }
      let name = this.next();
      let alias: string | null = null;
      if (this.peek() === ':') { this.next(); alias = name; name = this.next(); }
      const args = this.parseArgs();
      const selection = this.peek() === '{' ? this.parseSelection() : null;
      fields.push({ name, alias, args, selection, fragmentType: null, isFragment: false });
    }
    this.expect('}');
    return fields;
  }
  parseDocument(): { operation: string; selection: GqlField[] } {
    // skip `query Name($var: Type, ...)` / `mutation Name(...)` header
    let operation = 'query';
    while (this.pos < this.tokens.length) {
      const t = this.peek()!;
      if (t === '{') break;
      if (t === 'query' || t === 'mutation') { operation = t; this.next(); continue; }
      this.next();
      if (this.peek() === '(') {
        // skip variable definitions
        let depth = 0;
        while (this.pos < this.tokens.length) {
          const x = this.next();
          if (x === '(' || x === '[' || x === '{') depth += 1;
          if (x === ')' || x === ']' || x === '}') { depth -= 1; if (depth === 0) break; }
        }
      }
    }
    const selection = this.parseSelection();
    return { operation, selection };
  }
}
function evalValue(v: GqlValue, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var': return vars[v.name];
    case 'string': case 'int': case 'float': case 'bool': return v.value;
    case 'null': return null;
    case 'enum': return v.value;
    case 'list': return v.items.map((i) => evalValue(i, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, val] of v.fields) out[k] = evalValue(val, vars);
      return out;
    }
  }
}
function evalArgs(field: GqlField, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of field.args) out[k] = evalValue(v, vars);
  return out;
}
// ---- type field tables for __type ----
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'url', 'comments', 'labels', 'assignees', 'closedAt', 'repository'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'merged', 'mergedAt', 'mergeCommit', 'files', 'author', 'createdAt', 'updatedAt', 'url', 'repository', 'reviews', 'commits'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issues', 'issue', 'pullRequests', 'pullRequest', 'url', 'createdAt', 'updatedAt', 'description', 'isPrivate', 'fork', 'stargazerCount', 'watchers'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url'],
  IssueComment: ['id', 'databaseId', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  Ref: ['id', 'name', 'target', 'prefix'],
  SearchType: [],
};
const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'ORGANIZATION', 'PULL_REQUEST'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
};
function typeInfo(name: string): Record<string, unknown> {
  const isEnum = name in ENUM_VALUES;
  return {
    name,
    kind: isEnum ? 'ENUM' : 'OBJECT',
    fields: isEnum ? null : (TYPE_FIELDS[name] ?? []).map((f) => ({ name: f })),
    enumValues: isEnum ? ENUM_VALUES[name].map((v) => ({ name: v })) : null,
  };
}
// ---- resolvers ----
function cursorFor(index: number): string { return Buffer.from(`cursor:${index}`, 'utf8').toString('base64'); }
function cursorIndex(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const d = Buffer.from(cursor, 'base64').toString('utf8');
    const m = d.match(/^cursor:(\d+)$/);
    return m ? parseInt(m[1], 10) : -1;
  } catch { return -1; }
}
function pageInfoFor(items: unknown[], afterIdx: number, total: number): Record<string, unknown> {
  const start = afterIdx + 1;
  return {
    hasNextPage: start + items.length < total,
    hasPreviousPage: start > 0,
    startCursor: items.length ? cursorFor(start) : null,
    endCursor: items.length ? cursorFor(start + items.length - 1) : null,
  };
}
function repoGql(r: Repo): Record<string, unknown> {
  return {
    __type: 'Repository', __repo: r,
    id: gid('Repository', r.id), databaseId: r.id, name: r.name, nameWithOwner: r.fullName,
    owner: { __type: 'User', login: VIEWER.login, id: gid('User', VIEWER.id), name: VIEWER.name, email: VIEWER.email },
    defaultBranchRef: r.tip() ? { __type: 'Ref', name: r.defaultBranch, target: { oid: r.tip() } } : null,
    viewerPermission: 'ADMIN', hasIssuesEnabled: true,
    url: `https://github.com/${r.fullName}`, createdAt: isoForCached(r.createdSeq), updatedAt: isoForCached(r.createdSeq),
    description: r.description, isPrivate: r.isPrivate, fork: false,
  };
}
function issueGql(r: Repo, i: IssueRec): Record<string, unknown> {
  return {
    __type: 'Issue', __repo: r, __issue: i,
    id: gid('Issue', r.id, i.number), databaseId: i.id, number: i.number, title: i.title, body: i.body,
    state: i.state === 'open' ? 'OPEN' : 'CLOSED',
    author: { __type: 'User', login: VIEWER.login, id: gid('User', VIEWER.id), name: VIEWER.name, email: VIEWER.email },
    createdAt: isoForCached(i.createdSeq), updatedAt: isoForCached(i.updatedSeq),
    url: `https://github.com/${r.fullName}/issues/${i.number}`,
    comments: { __type: 'IssueCommentConnection', __repo: r, __issue: i },
    labels: { __type: 'LabelConnection', nodes: i.labels.map((l) => ({ name: l })) },
  };
}
function pullGql(r: Repo, p: PullRec): Record<string, unknown> {
  return {
    __type: 'PullRequest', __repo: r, __pull: p,
    id: gid('PullRequest', r.id, p.number), databaseId: p.id, number: p.number, title: p.title, body: p.body,
    state: p.merged ? 'MERGED' : p.state === 'open' ? 'OPEN' : 'CLOSED',
    headRefName: p.headRef, baseRefName: p.baseRef,
    headRefOid: p.headSha, baseRefOid: p.baseSha,
    mergeable: 'MERGEABLE', merged: p.merged, mergedAt: p.mergedAt,
    mergeCommit: p.mergeCommitSha ? { oid: p.mergeCommitSha } : null,
    author: { __type: 'User', login: VIEWER.login, id: gid('User', VIEWER.id), name: VIEWER.name, email: VIEWER.email },
    createdAt: isoForCached(p.createdSeq), updatedAt: isoForCached(p.updatedSeq),
    url: `https://github.com/${r.fullName}/pull/${p.number}`,
    files: { __type: 'PullRequestFileConnection', __repo: r, __pull: p },
  };
}
function issueConnection(r: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let list = [...r.issues];
  const states = args.states as string[] | undefined;
  if (states && states.length) {
    const want = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => want.has(i.state));
  }
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  if (orderBy) {
    const dir = String(orderBy.direction ?? 'DESC');
    list.sort((a, b) => dir === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq);
  }
  const afterIdx = cursorIndex(args.after);
  const first = typeof args.first === 'number' ? args.first : 100;
  const page = list.slice(afterIdx + 1, afterIdx + 1 + first);
  return {
    __type: 'IssueConnection', __repo: r,
    nodes: page.map((i) => issueGql(r, i)),
    edges: page.map((i, k) => ({ node: issueGql(r, i), cursor: cursorFor(afterIdx + 1 + k) })),
    totalCount: list.length,
    pageInfo: pageInfoFor(page, afterIdx, list.length),
  };
}
function pullConnection(r: Repo, args: Record<string, unknown>): Record<string, unknown> {
  const list = [...r.pulls];
  const afterIdx = cursorIndex(args.after);
  const first = typeof args.first === 'number' ? args.first : 100;
  const page = list.slice(afterIdx + 1, afterIdx + 1 + first);
  return {
    __type: 'PullRequestConnection', __repo: r,
    nodes: page.map((p) => pullGql(r, p)),
    edges: page.map((p, k) => ({ node: pullGql(r, p), cursor: cursorFor(afterIdx + 1 + k) })),
    totalCount: list.length,
    pageInfo: pageInfoFor(page, afterIdx, list.length),
  };
}
class GqlExecutor {
  errors: Array<Record<string, unknown>> = [];
  resolveFields(parent: Record<string, unknown> | null, typeName: string, selection: GqlField[], vars: Record<string, unknown>, path: string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of selection) {
      if (field.fragmentType && field.fragmentType !== typeName) continue;
      const key = field.alias ?? field.name;
      const value = this.resolveField(parent, typeName, field, vars, [...path, key]);
      out[key] = value;
    }
    return out;
  }
  resolveField(parent: Record<string, unknown> | null, typeName: string, field: GqlField, vars: Record<string, unknown>, path: string[]): unknown {
    const args = evalArgs(field, vars);
    const sel = field.selection;
    const sub = (value: unknown, t: string): unknown => {
      if (value === null || value === undefined) return null;
      if (!sel) return value;
      if (Array.isArray(value)) return value.map((v) => this.resolveFields(v as Record<string, unknown>, t, sel, vars, path));
      return this.resolveFields(value as Record<string, unknown>, t, sel, vars, path);
    };
    // __type introspection
    if (field.name === '__type') {
      const name = String(args.name ?? '');
      return sub(typeInfo(name), '__Type');
    }
    if (field.name === '__typename') return typeName;
    if (typeName === 'Query') {
      if (field.name === 'viewer') return sub({ __type: 'User', login: VIEWER.login, id: gid('User', VIEWER.id), name: VIEWER.name, email: VIEWER.email }, 'User');
      if (field.name === 'repository') {
        const r = getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return r ? sub(repoGql(r), 'Repository') : null;
      }
      if (field.name === 'node') {
        const parsed = parseGid(String(args.id ?? ''));
        if (!parsed) return null;
        if (parsed.kind === 'Repository') {
          const r = [...repos.values()].find((x) => x.id === parseInt(parsed.parts[0], 10));
          return r ? sub(repoGql(r), 'Repository') : null;
        }
        if (parsed.kind === 'Issue') {
          const r = [...repos.values()].find((x) => x.id === parseInt(parsed.parts[0], 10));
          const i = r?.issuesByNum.get(parseInt(parsed.parts[1], 10));
          return r && i ? sub(issueGql(r, i), 'Issue') : null;
        }
        if (parsed.kind === 'PullRequest') {
          const r = [...repos.values()].find((x) => x.id === parseInt(parsed.parts[0], 10));
          const p = r?.pullsByNum.get(parseInt(parsed.parts[1], 10));
          return r && p ? sub(pullGql(r, p), 'PullRequest') : null;
        }
        return null;
      }
      this.errors.push({ message: `Cannot query field "${field.name}" on type "Query".`, path });
      return null;
    }
    if (typeName === 'Mutation') {
      const result = this.doMutation(field.name, args);
      if (result === undefined) { this.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".`, path }); return null; }
      if (result === null) return null;
      return sub(result.value, result.type);
    }
    if (!parent) return null;
    if (typeName === 'Repository') {
      const r = parent.__repo as Repo;
      if (field.name === 'issues') return sub(issueConnection(r, args), 'IssueConnection');
      if (field.name === 'issue') {
        const i = r.issuesByNum.get(Number(args.number));
        return i ? sub(issueGql(r, i), 'Issue') : null;
      }
      if (field.name === 'pullRequests') return sub(pullConnection(r, args), 'PullRequestConnection');
      if (field.name === 'pullRequest') {
        const p = r.pullsByNum.get(Number(args.number));
        return p ? sub(pullGql(r, p), 'PullRequest') : null;
      }
      if (field.name in parent) return sub(parent[field.name], this.childType(typeName, field.name));
      this.errors.push({ message: `Cannot query field "${field.name}" on type "Repository".`, path });
      return null;
    }
    if (typeName === 'PullRequest') {
      const r = parent.__repo as Repo;
      const p = parent.__pull as PullRec;
      if (field.name === 'files') {
        const files = pullFiles(r, p);
        const afterIdx = cursorIndex(args.after);
        const first = typeof args.first === 'number' ? args.first : 100;
        const page = files.slice(afterIdx + 1, afterIdx + 1 + first);
        return sub({
          __type: 'PullRequestFileConnection',
          nodes: page.map((f) => ({ __type: 'PullRequestFile', path: f.filename, additions: f.additions, deletions: f.deletions, changes: f.changes })),
          edges: page.map((f, k) => ({ node: { __type: 'PullRequestFile', path: f.filename }, cursor: cursorFor(afterIdx + 1 + k) })),
          totalCount: files.length,
          pageInfo: pageInfoFor(page, afterIdx, files.length),
        }, 'PullRequestFileConnection');
      }
      if (field.name in parent) return sub(parent[field.name], this.childType(typeName, field.name));
      this.errors.push({ message: `Cannot query field "${field.name}" on type "PullRequest".`, path });
      return null;
    }
    if (typeName === 'IssueCommentConnection') {
      const r = parent.__repo as Repo;
      const i = parent.__issue as IssueRec;
      if (field.name === 'nodes') {
        return i.comments.map((c) => sub({ __type: 'IssueComment', id: gid('IssueComment', r.id, i.number, c.id), databaseId: c.id, body: c.body, author: { __type: 'User', login: VIEWER.login, id: gid('User', VIEWER.id) }, createdAt: isoForCached(c.createdSeq) }, 'IssueComment'));
      }
      if (field.name === 'totalCount') return i.comments.length;
      if (field.name === 'pageInfo') return sub(pageInfoFor(i.comments, -1, i.comments.length), 'PageInfo');
      this.errors.push({ message: `Cannot query field "${field.name}" on type "IssueCommentConnection".`, path });
      return null;
    }
    if (typeName === 'IssueConnection' || typeName === 'PullRequestConnection' || typeName === 'PullRequestFileConnection' || typeName === 'LabelConnection') {
      if (field.name === 'nodes' || field.name === 'edges' || field.name === 'totalCount' || field.name === 'pageInfo') {
        const v = parent[field.name];
        if (field.name === 'nodes' && Array.isArray(v)) return v.map((n) => sub(n, this.childType(typeName, 'nodes')));
        if (field.name === 'edges' && Array.isArray(v)) return v.map((e) => sub(e as Record<string, unknown>, 'Edge'));
        return sub(v, field.name === 'pageInfo' ? 'PageInfo' : 'Int');
      }
      this.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".`, path });
      return null;
    }
    if (typeName === 'Edge') {
      if (field.name === 'node') return sub(parent.node, this.childType(typeName, 'node'));
      if (field.name === 'cursor') return parent.cursor;
      this.errors.push({ message: `Cannot query field "${field.name}" on type "Edge".`, path });
      return null;
    }
    // Scalar object types: User, Ref, Issue, IssueComment, PullRequestFile, PageInfo, __Type
    if (field.name in parent) {
      const v = parent[field.name];
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && sel) {
        const t = (v as Record<string, unknown>).__type as string | undefined;
        return sub(v, t ?? this.childType(typeName, field.name));
      }
      return sub(v, this.childType(typeName, field.name));
    }
    this.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".`, path });
    return null;
  }
  childType(parentType: string, field: string): string {
    const map: Record<string, string> = {
      'Repository.owner': 'User', 'Repository.defaultBranchRef': 'Ref', 'Repository.issues': 'IssueConnection',
      'Repository.pullRequests': 'PullRequestConnection', 'Repository.issue': 'Issue', 'Repository.pullRequest': 'PullRequest',
      'Issue.author': 'User', 'Issue.comments': 'IssueCommentConnection', 'Issue.labels': 'LabelConnection',
      'PullRequest.author': 'User', 'PullRequest.mergeCommit': 'Commit', 'PullRequest.files': 'PullRequestFileConnection',
      'Ref.target': 'GitObject', 'IssueConnection.nodes': 'Issue', 'PullRequestConnection.nodes': 'PullRequest',
      'PullRequestFileConnection.nodes': 'PullRequestFile', 'Edge.node': 'Node', 'User.id': 'ID',
    };
    return map[`${parentType}.${field}`] ?? 'String';
  }
  doMutation(name: string, args: Record<string, unknown>): { value: Record<string, unknown>; type: string } | null | undefined {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (name === 'createIssue') {
      const parsed = parseGid(String(input.repositoryId ?? ''));
      if (!parsed || parsed.kind !== 'Repository') return null;
      const r = [...repos.values()].find((x) => x.id === parseInt(parsed.parts[0], 10));
      if (!r) return null;
      const n = nextSeq();
      const issue: IssueRec = {
        number: r.issues.length + 1, id: ++issueIdSeq, title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '', state: 'open', labels: [],
        createdSeq: n, updatedSeq: n, comments: [], jsonCache: null,
      };
      r.issues.push(issue);
      r.issuesByNum.set(issue.number, issue);
      return { value: { __type: 'CreateIssuePayload', issue: issueGql(r, issue), clientMutationId: (input.clientMutationId as string | null) ?? null }, type: 'CreateIssuePayload' };
    }
    if (name === 'closeIssue') {
      const parsed = parseGid(String(input.issueId ?? ''));
      if (!parsed || parsed.kind !== 'Issue') return null;
      const r = [...repos.values()].find((x) => x.id === parseInt(parsed.parts[0], 10));
      const i = r?.issuesByNum.get(parseInt(parsed.parts[1], 10));
      if (!r || !i) return null;
      i.state = 'closed';
      i.updatedSeq = nextSeq();
      return { value: { __type: 'CloseIssuePayload', issue: issueGql(r, i), clientMutationId: (input.clientMutationId as string | null) ?? null }, type: 'CloseIssuePayload' };
    }
    if (name === 'createPullRequest') {
      const parsed = parseGid(String(input.repositoryId ?? ''));
      if (!parsed || parsed.kind !== 'Repository') return null;
      const r = [...repos.values()].find((x) => x.id === parseInt(parsed.parts[0], 10));
      if (!r) return null;
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      const headSha = r.tip(head);
      const baseSha = r.tip(base);
      if (!headSha || !baseSha) return null;
      const n = nextSeq();
      const pull: PullRec = {
        number: r.pulls.length + 1, id: ++pullIdSeq, title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '', state: 'open',
        merged: false, mergedAt: null, mergeCommitSha: null,
        headRef: head, headSha, baseRef: base, baseSha, createdSeq: n, updatedSeq: n,
      };
      r.pulls.push(pull);
      r.pullsByNum.set(pull.number, pull);
      return { value: { __type: 'CreatePullRequestPayload', pullRequest: pullGql(r, pull), clientMutationId: (input.clientMutationId as string | null) ?? null }, type: 'CreatePullRequestPayload' };
    }
    if (name === 'mergePullRequest') {
      const parsed = parseGid(String(input.pullRequestId ?? ''));
      if (!parsed || parsed.kind !== 'PullRequest') return null;
      const r = [...repos.values()].find((x) => x.id === parseInt(parsed.parts[0], 10));
      const p = r?.pullsByNum.get(parseInt(parsed.parts[1], 10));
      if (!r || !p) return null;
      const result = mergePull(r, p);
      if ('error' in result) return null;
      return { value: { __type: 'MergePullRequestPayload', pullRequest: pullGql(r, p), clientMutationId: (input.clientMutationId as string | null) ?? null }, type: 'MergePullRequestPayload' };
    }
    if (name === 'addComment') {
      const parsed = parseGid(String(input.subjectId ?? ''));
      if (!parsed || parsed.kind !== 'Issue') return null;
      const r = [...repos.values()].find((x) => x.id === parseInt(parsed.parts[0], 10));
      const i = r?.issuesByNum.get(parseInt(parsed.parts[1], 10));
      if (!r || !i) return null;
      const c = { id: ++commentIdSeq, body: String(input.body ?? ''), createdSeq: nextSeq() };
      i.comments.push(c);
      i.updatedSeq = nextSeq();
      return {
        value: {
          __type: 'AddCommentPayload',
          commentEdge: { node: { __type: 'IssueComment', id: gid('IssueComment', r.id, i.number, c.id), databaseId: c.id, body: c.body, author: { __type: 'User', login: VIEWER.login, id: gid('User', VIEWER.id) }, createdAt: isoForCached(c.createdSeq) } },
          clientMutationId: (input.clientMutationId as string | null) ?? null,
        },
        type: 'AddCommentPayload',
      };
    }
    return undefined;
  }
  execute(query: string, variables: Record<string, unknown>): Record<string, unknown> {
    this.errors = [];
    try {
      const parser = new GqlParser(query);
      const doc = parser.parseDocument();
      const rootType = doc.operation === 'mutation' ? 'Mutation' : 'Query';
      const data = this.resolveFields(null, rootType, doc.selection, variables, []);
      const out: Record<string, unknown> = { data };
      if (this.errors.length) out.errors = this.errors;
      return out;
    } catch (e) {
      return { data: null, errors: [{ message: e instanceof Error ? e.message : String(e) }] };
    }
  }
}
async function handleGraphQL(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  if (!authed(req)) { sendErr(res, 401, 'Requires authentication'); return; }
  const parsed = await readJsonBody(req);
  if (!parsed.ok) { sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] }); return; }
  const exec = new GqlExecutor();
  const runOne = (op: unknown): Record<string, unknown> => {
    if (!isRec(op) || typeof op.query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
    const vars = isRec(op.variables) ? (op.variables as Record<string, unknown>) : {};
    return exec.execute(op.query, vars);
  };
  if (Array.isArray(parsed.value)) sendJson(res, 200, parsed.value.map(runOne));
  else sendJson(res, 200, runOne(parsed.value));
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol, Streamable HTTP)
// ---------------------------------------------------------------------------
const MCP_TOOLS = [
  { name: 'create_repo', description: 'Create a new repository owned by the authenticated user.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' }, labels: { type: 'array', items: { type: 'string' }, description: 'Label names' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Issue state: open, closed, or all' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, body: { type: 'string', description: 'Pull request body' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] } },
];
function mcpText(obj: unknown): Record<string, unknown> {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: isRec(obj) ? obj : { result: obj } };
}
function mcpErrObj(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true };
}
function mcpRepoFromArgs(args: Record<string, unknown>): Repo | null {
  let owner = String(args.owner ?? '');
  let repo = String(args.repo ?? args.repository ?? '');
  if (!repo && owner.includes('/')) { const [o, r] = owner.split('/'); owner = o; repo = r; }
  if (!owner) owner = VIEWER.login;
  if (!repo) return null;
  return getRepo(owner, repo) ?? null;
}
function mcpCall(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name ?? '');
      if (!repoName) return mcpErrObj('name is required');
      if (repos.has(`${VIEWER.login}/${repoName}`)) return mcpErrObj('Repository already exists');
      const repo = new Repo(++repoIdSeq, repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      repos.set(repo.fullName, repo);
      return mcpText(repoJson(repo));
    }
    case 'get_repo': {
      const repo = mcpRepoFromArgs(args);
      if (!repo) return mcpErrObj('Not Found');
      return mcpText(repoJson(repo));
    }
    case 'create_issue': {
      const repo = mcpRepoFromArgs(args);
      if (!repo) return mcpErrObj('Not Found');
      const title = String(args.title ?? '');
      if (!title) return mcpErrObj('title is required');
      const labels: string[] = Array.isArray(args.labels) ? args.labels.filter((x): x is string => typeof x === 'string') : [];
      for (const l of labels) if (!repo.labels.has(l)) return mcpErrObj(`Label does not exist: ${l}`);
      const n = nextSeq();
      const issue: IssueRec = {
        number: repo.issues.length + 1, id: ++issueIdSeq, title,
        body: typeof args.body === 'string' ? args.body : '', state: 'open', labels,
        createdSeq: n, updatedSeq: n, comments: [], jsonCache: null,
      };
      repo.issues.push(issue);
      repo.issuesByNum.set(issue.number, issue);
      return mcpText(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = mcpRepoFromArgs(args);
      if (!repo) return mcpErrObj('Not Found');
      const state = String(args.state ?? 'open');
      const list = state === 'all' ? repo.issues : repo.issues.filter((i) => i.state === state);
      return mcpText({ issues: list.map((i) => issueJson(repo, i)) });
    }
    case 'create_pull_request': {
      const repo = mcpRepoFromArgs(args);
      if (!repo) return mcpErrObj('Not Found');
      const title = String(args.title ?? '');
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      if (!title || !head || !base) return mcpErrObj('title, head and base are required');
      const headSha = repo.tip(head);
      const baseSha = repo.tip(base);
      if (!headSha || !baseSha) return mcpErrObj('head or base branch does not exist');
      const n = nextSeq();
      const pull: PullRec = {
        number: repo.pulls.length + 1, id: ++pullIdSeq, title,
        body: typeof args.body === 'string' ? args.body : '', state: 'open',
        merged: false, mergedAt: null, mergeCommitSha: null,
        headRef: head, headSha, baseRef: base, baseSha, createdSeq: n, updatedSeq: n,
      };
      repo.pulls.push(pull);
      repo.pullsByNum.set(pull.number, pull);
      return mcpText(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = mcpRepoFromArgs(args);
      if (!repo) return mcpErrObj('Not Found');
      const num = Number(args.pull_number ?? args.number ?? 0);
      const pull = repo.pullsByNum.get(num);
      if (!pull) return mcpErrObj('Not Found');
      const result = mergePull(repo, pull);
      if ('error' in result) return mcpErrObj(result.error);
      return mcpText({ sha: result.sha, merged: true, message: `Merge pull request #${pull.number} from ${pull.headRef}` });
    }
    default:
      return mcpErrObj(`unknown tool: ${name}`);
  }
}
async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const raw = await readBody(req);
  const text = raw.toString('utf8');
  const rpc = (id: unknown, result: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
  };
  const rpcErr = (id: unknown, code: number, message: string, status = 200): void => {
    sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  };
  let msg: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRec(parsed)) throw new Error('not an object');
    msg = parsed;
  } catch {
    rpcErr(null, -32700, 'Parse error', 400);
    return;
  }
  const id = msg.id ?? null;
  const method = String(msg.method ?? '');
  if (method === '' || method.startsWith('notifications/')) {
    // Notification: no JSON-RPC response.
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end();
    return;
  }
  if (method === 'initialize') {
    const params = isRec(msg.params) ? msg.params : {};
    const requested = String(params.protocolVersion ?? '');
    const supported = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    const version = supported.includes(requested) ? requested : '2025-11-25';
    rpc(id, {
      protocolVersion: version,
      capabilities: { tools: {} },
      serverInfo: { name: 'github-forge', version: '1.0.0' },
    });
    return;
  }
  if (method === 'server/discover') {
    rpc(id, {
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      serverInfo: { name: 'github-forge', version: '1.0.0' },
      capabilities: { tools: {} },
    });
    return;
  }
  // All tool operations require auth.
  if (!authed(req)) {
    res.writeHead(401, { 'content-type': 'application/json', ...jsonHeaders() });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: 'Requires authentication' } }));
    return;
  }
  if (method === 'tools/list') {
    rpc(id, { tools: MCP_TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const params = isRec(msg.params) ? msg.params : {};
    const toolName = String(params.name ?? '');
    const tool = MCP_TOOLS.find((t) => t.name === toolName);
    if (!tool) { rpcErr(id, -32602, `unknown tool: ${toolName}`); return; }
    const args = isRec(params.arguments) ? (params.arguments as Record<string, unknown>) : null;
    if (args === null) { rpc(id, mcpErrObj('arguments are required')); return; }
    // Missing required arguments -> isError, never HTTP 500.
    const schema = tool.inputSchema as { required?: string[] };
    const missing = (schema.required ?? []).filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
    if (missing.length) { rpc(id, mcpErrObj(`missing required argument(s): ${missing.join(', ')}`)); return; }
    try {
      rpc(id, mcpCall(toolName, args));
    } catch (e) {
      rpc(id, mcpErrObj(e instanceof Error ? e.message : String(e)));
    }
    return;
  }
  if (method === 'ping') { rpc(id, {}); return; }
  rpcErr(id, -32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
export function createApp(): http.Server {
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        const parts = parsePath(url.pathname);
        if (url.pathname === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (parts[0] === 'api' && parts[1] === 'v3') {
          await handleRest(req, res, url, parts);
          return;
        }
        if (parts[0] === 'api' && parts[1] === 'graphql') {
          if (req.method !== 'POST') { sendErr(res, 404, 'Not Found'); return; }
          await handleGraphQL(req, res);
          return;
        }
        if (parts[0] === 'mcp') {
          if (req.method !== 'POST') { sendErr(res, 404, 'Not Found'); return; }
          await handleMcp(req, res);
          return;
        }
        // Git: /:owner/:repo[.git]/info/refs | git-upload-pack | git-receive-pack
        const gitParts = [...parts];
        if (gitParts.length >= 2 && gitParts[1].endsWith('.git')) gitParts[1] = gitParts[1].slice(0, -4);
        const handled = await handleGit(req, res, gitParts, url);
        if (!handled) sendErr(res, 404, 'Not Found');
      } catch (e) {
        if (!res.headersSent) sendErr(res, 500, e instanceof Error ? e.message : 'Internal error');
        else res.end();
      }
    })();
  });
  return server;
}
