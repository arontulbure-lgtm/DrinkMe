// Scan photos are kept ONLY for users who opted in (aiPhotoOptIn, off by default). Everyone else's photo
// lives in memory for the request and is gone afterwards. Kept files are deleted after the retention period
// and with the account. File names hold a hash of the user id, never the id or an email.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

export const createPhotoStore = ({ dir, retentionDays = 90 }) => {
  const userPrefix = (userId) => crypto.createHash('sha256').update(`drinkme-scan:${userId}`).digest('hex').slice(0, 24);
  const ensureDir = () => fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  return {
    dir,
    retentionDays,
    /** Saves the photo and the scan result. Never throws: a failed save must not fail the scan. */
    save(userId, bytes, extension, result) {
      try {
        ensureDir();
        const base = `${userPrefix(userId)}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        fs.writeFileSync(path.join(dir, `${base}.${extension}`), bytes, { mode: 0o600 });
        fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify({ savedAt: new Date().toISOString(), result }), { mode: 0o600 });
        return true;
      } catch (err) {
        console.warn('[ai] Could not keep the opted-in scan photo:', err.code ?? err.name);
        return false;
      }
    },
    /** Deletes every kept photo of one user (opt-out and account deletion). Returns the number of files removed. */
    deleteForUser(userId) {
      const prefix = `${userPrefix(userId)}_`;
      let removed = 0;
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return 0; }
      for (const name of names) {
        if (!name.startsWith(prefix)) continue;
        try { fs.rmSync(path.join(dir, name), { force: true }); removed++; } catch (err) {
          console.warn('[ai] Could not delete a kept scan photo:', err.code ?? err.name);
        }
      }
      return removed;
    },
    /** Deletes files older than the retention period. */
    purgeExpired(now = Date.now()) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return 0; }
      let removed = 0;
      for (const name of names) {
        const savedAt = Number(name.split('_')[1]);
        if (Number.isFinite(savedAt) && now - savedAt > retentionDays * DAY_MS) {
          try { fs.rmSync(path.join(dir, name), { force: true }); removed++; } catch { /* next run */ }
        }
      }
      return removed;
    },
  };
};
