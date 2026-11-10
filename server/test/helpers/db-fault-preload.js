// Test-only: loaded into the server through NODE_OPTIONS=--import. DB_FAULT picks the failure.
import fs from 'node:fs';
import path from 'node:path';

import validator from 'validator';

const FAULT_USER_ID = 'fault-injected-user';

const dbFile = path.resolve(process.env.DB_FILE);
const isDbFile = (file) => path.resolve(String(file)) === dbFile;
const isBackupFile = (file) => (
  [`${dbFile}.corrupt-`, `${dbFile}.pre-migration-`].some((prefix) => path.resolve(String(file)).startsWith(prefix))
);
const fault = (code) => Object.assign(new Error(`injected ${code}`), { code });

const failOnDbFile = (method, code, shouldFail = () => true) => {
  const real = fs[method];
  fs[method] = (file, ...rest) => {
    if (isDbFile(file) && shouldFail()) throw fault(code);
    return real(file, ...rest);
  };
};

const wrapOpenOfBackup = (onBackupOpen) => {
  const realOpen = fs.openSync;
  fs.openSync = (file, ...rest) => (
    isBackupFile(file) ? onBackupOpen(realOpen, file, ...rest) : realOpen(file, ...rest)
  );
};

let readsToFail = 2;
const faults = {
  stat: () => failOnDbFile('statSync', 'EACCES'),
  read: () => failOnDbFile('readFileSync', 'EBUSY'),
  'read-transient': () => failOnDbFile('readFileSync', 'EBUSY', () => readsToFail-- > 0),
  'backup-open': () => wrapOpenOfBackup(() => {
    throw fault('EACCES');
  }),
  // A decoy at the backup path makes the real open fail with a real EEXIST.
  'backup-exists': () => {
    const realWrite = fs.writeFileSync;
    wrapOpenOfBackup((realOpen, file, ...rest) => {
      realWrite(file, 'existing backup');
      return realOpen(file, ...rest);
    });
  },
  // The real file is created first, so this covers cleanup of a partial backup.
  'backup-fsync': () => {
    const backupFds = new Set();
    wrapOpenOfBackup((realOpen, file, ...rest) => {
      const fd = realOpen(file, ...rest);
      backupFds.add(fd);
      return fd;
    });
    const realFsync = fs.fsyncSync;
    fs.fsyncSync = (fd) => {
      if (backupFds.has(fd)) throw fault('EIO');
      return realFsync(fd);
    };
  },
  'backup-mismatch': () => {
    const realRead = fs.readFileSync;
    fs.readFileSync = (file, ...rest) => (
      isBackupFile(file) ? Buffer.from('different bytes') : realRead(file, ...rest)
    );
  },
  // Saves fail only while the marker file exists, so a test can sign in first.
  save: () => {
    const realRename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (isDbFile(to) && fs.existsSync(`${dbFile}.fail-saves`)) throw fault('EIO');
      return realRename(from, to);
    };
  },
  // The server calls unescape only while decoding at startup, and in the AI routes.
  migrate: () => {
    validator.unescape = () => {
      throw new TypeError('injected migration failure');
    };
  },
  // Stops account deletion part of the way through, while the marker file exists.
  cascade: () => {
    const realDelete = Map.prototype.delete;
    Map.prototype.delete = function deleteEntry(key) {
      // Only a map of Sets, such as cheersByUser, so the server's other bookkeeping keeps working.
      if (key === FAULT_USER_ID && this.get(key) instanceof Set && fs.existsSync(`${dbFile}.fail-cascade`)) throw new TypeError('injected cascade failure');
      return realDelete.call(this, key);
    };
  },
  restore: () => {
    const realSet = Map.prototype.set;
    Map.prototype.set = function set(key, value) {
      if (key === FAULT_USER_ID) throw new TypeError('injected restore failure');
      return realSet.call(this, key, value);
    };
  },
};
faults[process.env.DB_FAULT]?.();
