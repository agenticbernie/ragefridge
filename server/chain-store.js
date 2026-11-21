import { constants, promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const STORE_FILE = 'matches.json';
const validRecord = (record) => record && typeof record === 'object' && !Array.isArray(record) &&
  typeof record.matchId === 'string' && /^0x[0-9a-f]{64}$/i.test(record.matchId);

/** A small, single-process store for chain coordination records and private role seeds. */
export class JsonChainStore {
  constructor(directory) {
    if (typeof directory !== 'string' || !directory.trim()) {
      throw new TypeError('A dedicated CHAIN_STATE_DIR is required.');
    }
    this.directory = directory;
    this.path = join(directory, STORE_FILE);
    this.records = new Map();
    this.initialized = false;
    this.writeQueue = Promise.resolve();
  }

  async init() {
    if (this.initialized) return this;
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const dirInfo = await fs.lstat(this.directory);
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
      throw new Error('CHAIN_STATE_DIR must be a real directory, not a symlink.');
    }
    await fs.chmod(this.directory, 0o700);

    let file;
    try {
      file = await fs.open(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (file) {
      try {
        const info = await file.stat();
        if (!info.isFile()) throw new Error('Chain state file is not a regular file.');
        const contents = await file.readFile('utf8');
        const parsed = JSON.parse(contents);
        if (!Array.isArray(parsed)) throw new Error('Chain state file has an invalid format.');
        const loaded = new Map();
        for (const record of parsed) {
          if (!validRecord(record) || loaded.has(record.matchId.toLowerCase())) {
            throw new Error('Chain state file contains an invalid match record.');
          }
          loaded.set(record.matchId.toLowerCase(), record);
        }
        this.records = loaded;
        await fs.chmod(this.path, 0o600);
      } finally {
        await file.close();
      }
    }
    this.initialized = true;
    return this;
  }

  get(matchId) {
    return structuredClone(this.records.get(String(matchId).toLowerCase()) ?? null);
  }

  all() {
    return structuredClone([...this.records.values()]);
  }

  async put(record) {
    if (!this.initialized) throw new Error('Chain store has not been initialized.');
    if (!validRecord(record)) throw new TypeError('A valid match ID is required.');
    const key = record.matchId.toLowerCase();
    this.records.set(key, structuredClone(record));
    return this.persist();
  }

  async persist() {
    const write = async () => {
      const temporary = join(this.directory, `.${basename(this.path)}.${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(`${JSON.stringify([...this.records.values()])}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temporary, this.path);
        const directoryHandle = await fs.open(dirname(this.path), constants.O_RDONLY);
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
        await fs.chmod(this.path, 0o600);
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        await fs.unlink(temporary).catch(() => {});
        throw error;
      }
    };
    const pending = this.writeQueue.then(write, write);
    this.writeQueue = pending.catch(() => {});
    return pending;
  }
}

export { STORE_FILE as CHAIN_STORE_FILENAME };
