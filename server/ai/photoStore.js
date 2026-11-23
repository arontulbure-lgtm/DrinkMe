// Scan photos are kept ONLY for users who opted in (aiPhotoOptIn, off by default). Everyone else's photo
// lives in memory for the request and is gone afterwards. Kept files are deleted after the retention period,
// on opt-out and with the account. File names hold a hash of the user id, never the id or an email.
// Metadata (EXIF with GPS location, XMP, IPTC, comments) is removed before a photo is kept: the scanner does not
// need it (GDPR data minimisation).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Removes metadata segments from a JPEG (APP1-APP15 except APP2/ICC, COM) or chunks from a PNG (tEXt, zTXt,
 * iTXt, eXIf, tIME). Returns null for anything it cannot parse safely (then nothing is kept).
 */
export const stripImageMetadata = (bytes, extension) => {
  if (extension === 'jpeg') {
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
    const parts = [bytes.subarray(0, 2)];
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      const marker = bytes[offset + 1];
      if (marker === 0xda) { parts.push(bytes.subarray(offset)); return Buffer.concat(parts); } // start of scan: rest is image data
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) return null;
      const isMetadata = (marker >= 0xe1 && marker <= 0xef && marker !== 0xe2) || marker === 0xfe;
      if (!isMetadata) parts.push(bytes.subarray(offset, offset + 2 + length));
      offset += 2 + length;
    }
    return null;
  }
  if (extension === 'png') {
    if (bytes.length < 8) return null;
    const parts = [bytes.subarray(0, 8)];
    let offset = 8;
    const drop = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
    while (offset + 12 <= bytes.length) {
      const length = bytes.readUInt32BE(offset);
      const type = bytes.toString('latin1', offset + 4, offset + 8);
      const end = offset + 12 + length;
      if (end > bytes.length) return null;
      if (!drop.has(type)) parts.push(bytes.subarray(offset, end));
      offset = end;
      if (type === 'IEND') return Buffer.concat(parts);
    }
    return null;
  }
  return null; // WebP and others: not kept (no safe metadata stripping here)
};

export const createPhotoStore = ({ dir, retentionDays = 90 }) => {
  const userPrefix = (userId) => crypto.createHash('sha256').update(`drinkme-scan:${userId}`).digest('hex').slice(0, 24);
  const ensureDir = () => fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  return {
    dir,
    retentionDays,
    /** Saves the photo (metadata removed) and the scan result. Never throws: a failed save must not fail the scan. */
    save(userId, bytes, extension, result) {
      const clean = stripImageMetadata(bytes, extension);
      if (!clean) return false;
      try {
        ensureDir();
        const base = `${userPrefix(userId)}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        fs.writeFileSync(path.join(dir, `${base}.${extension === 'jpeg' ? 'jpg' : extension}`), clean, { mode: 0o600 });
        fs.writeFileSync(path.join(dir, `${base}.json`), JSON.stringify({ savedAt: new Date().toISOString(), result }), { mode: 0o600 });
        return true;
      } catch (err) {
        console.warn('[ai] Could not keep the opted-in scan photo:', err.code ?? err.name);
        return false;
      }
    },
    /** Deletes every kept photo of one user (opt-out and account deletion). Returns { removed, failed }. */
    deleteForUser(userId) {
      const prefix = `${userPrefix(userId)}_`;
      let removed = 0;
      let failed = 0;
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch (err) {
        return { removed: 0, failed: err.code === 'ENOENT' ? 0 : 1 };
      }
      for (const name of names) {
        if (!name.startsWith(prefix)) continue;
        try { fs.rmSync(path.join(dir, name), { force: true }); removed++; } catch (err) {
          failed++;
          console.warn('[ai] Could not delete a kept scan photo:', err.code ?? err.name);
        }
      }
      return { removed, failed };
    },
    /** Deletes files older than the retention period. */
    /** Deletes every kept photo (no photo retention at launch, D-21/LC-49). Returns { removed, failed }. */
    deleteAll() {
      let names = [];
      try { names = fs.readdirSync(dir); } catch { return { removed: 0, failed: 0 }; }
      let removed = 0;
      let failed = 0;
      for (const name of names) {
        try { fs.rmSync(path.join(dir, name), { force: true }); removed++; } catch { failed++; }
      }
      return { removed, failed };
    },
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
