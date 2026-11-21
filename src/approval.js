import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isSkillUri } from './evidence.js';
import * as review from './review.js';

const queues = new Map();
const digest = text => createHash('sha256').update(text).digest('hex');
const hex = /^[a-f0-9]{64}$/;
const unfinished = new Set(['applying', 'restoring']);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
}

function snapshotHash(snapshot) {
  return digest(JSON.stringify(canonical(snapshot)));
}

async function save(directory, target, records) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.ledger-${randomUUID()}`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ version: 1, records }) + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, target);
    const parent = await open(directory, 'r');
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

function publicRecord(record) {
  const { status, approvalDigest, proposal } = record;
  return { status, approvalDigest, proposal };
}

export function createApprovalService({ directory, managedUri, adapter }) {
  if (!isAbsolute(directory) || !isSkillUri(managedUri) || !managedUri.startsWith('viking://user/') ||
      !['atomic-conditional', 'isolated-single-writer'].includes(adapter?.mode) ||
      !['read', 'replace', 'verifyIndex'].every(key => typeof adapter[key] === 'function')) {
    throw new TypeError('Approval requires an absolute ledger directory, a private skill and a verified adapter');
  }
  const root = resolve(directory);
  const target = join(root, 'approvals.json');

  function run(operation) {
    const queued = (queues.get(root) ?? Promise.resolve()).then(async () => {
      let records;
      try {
        const state = JSON.parse(await readFile(target, 'utf8'));
        if (state.version !== 1 || !Array.isArray(state.records)) throw Error('Invalid approval ledger');
        records = state.records;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        records = [];
      }
      return operation(records, () => save(root, target, records));
    });
    queues.set(root, queued.catch(() => {}));
    return queued;
  }

  async function readSnapshot() {
    const snapshot = await adapter.read(managedUri);
    if (typeof snapshot?.body !== 'string' || !snapshot.files || !snapshot.metadata) throw Error('Incomplete skill snapshot');
    return structuredClone(snapshot);
  }

  async function transition(record, status, persist) {
    record.status = status;
    record.history.push({ status, at: new Date().toISOString() });
    await persist();
    return publicRecord(record);
  }

  async function note(record, status, persist) {
    if (record.history.at(-1)?.status !== status) {
      record.history.push({ status, at: new Date().toISOString() });
      await persist();
    }
    return { status };
  }

  async function reconcile(record, persist) {
    const restoring = record.status === 'restoring';
    const expected = restoring ? record.before : record.after;
    let live;
    try {
      live = await readSnapshot();
    } catch {
      return note(record, 'write_unconfirmed', persist);
    }
    if (snapshotHash(live) !== snapshotHash(expected)) return note(record, 'write_unconfirmed', persist);
    let indexed;
    try {
      indexed = await adapter.verifyIndex(managedUri, expected);
    } catch {
      indexed = false;
    }
    if (!indexed) return note(record, 'index_unconfirmed', persist);
    return transition(record, restoring ? 'rolled_back' : 'applied', persist);
  }

  function vote(input, action) {
    return run(async (records, persist) => {
      input.signal?.throwIfAborted();
      const record = records.find(entry => entry.proposal.proposalId === input.id && entry.proposal.uri === managedUri);
      if (!record || record.proposal.evidence.sessionId !== input.sessionId || record.approvalDigest !== input.digest) {
        return { status: 'approval_mismatch' };
      }
      const restoring = action === 'rollback';
      if (action === 'reject') return record.status === 'pending' ? transition(record, 'rejected', persist) : publicRecord(record);
      if (unfinished.has(record.status)) {
        return record.status === (restoring ? 'restoring' : 'applying')
          ? reconcile(record, persist)
          : { status: 'unresolved_write' };
      }
      if (record.status !== (restoring ? 'applied' : 'pending')) return publicRecord(record);
      if (records.some(entry => entry.proposal.uri === managedUri && unfinished.has(entry.status))) {
        return { status: 'unresolved_write' };
      }
      const from = restoring ? record.after : record.before;
      const to = restoring ? record.before : record.after;
      await adapter.preflight?.(managedUri, to);
      const live = await readSnapshot();
      if (snapshotHash(live) !== snapshotHash(from)) {
        if (!restoring) return transition(record, 'conflict', persist);
        record.history.push({ status: 'rollback_conflict', at: new Date().toISOString() });
        await persist();
        return { status: 'rollback_conflict' };
      }
      input.signal?.throwIfAborted();
      const previous = record.status;
      await transition(record, restoring ? 'restoring' : 'applying', persist);
      let skipped = Boolean(input.signal?.aborted);
      if (!skipped) {
        try { skipped = (await adapter.replace(managedUri, to, from, input.signal)) === false; }
        catch { /* A failed response can follow a committed write. */ }
      }
      if (skipped) {
        await transition(record, previous, persist);
        return { status: 'cancelled' };
      }
      return reconcile(record, persist);
    });
  }

  return {
    stage(proposal) {
      return run(async (records, persist) => {
        if (proposal?.action !== 'patch' || proposal.uri !== managedUri || !hex.test(proposal.baseSha256) ||
            !hex.test(proposal.proposalId) || typeof proposal.evidence?.sessionId !== 'string') {
          return { status: 'not_managed' };
        }
        const { proposalId, ...display } = proposal;
        if (digest(JSON.stringify(display)) !== proposalId) return { status: 'invalid_proposal' };
        const existing = records.find(record => record.proposal.proposalId === proposalId);
        if (existing) return publicRecord(existing);
        const before = await readSnapshot();
        if (digest(before.body) !== proposal.baseSha256) return { status: 'conflict' };
        const after = { ...before, body: review.applySkillDiff(before.body, proposal.diff, managedUri) };
        const record = {
          proposal: structuredClone(proposal), before, after,
          approvalDigest: digest(JSON.stringify([proposalId, snapshotHash(before), snapshotHash(after)])),
          status: 'pending', history: [],
        };
        records.push(record);
        return transition(record, 'pending', persist);
      });
    },
    approve: input => vote(input, 'approve'),
    reject: input => vote(input, 'reject'),
    rollback: input => vote(input, 'rollback'),
  };
}
