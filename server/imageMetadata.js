// Removes metadata from uploaded post and avatar photos before they are stored (privacy policy: no GPS,
// GDPR data minimisation, legal LC-17). Phone photos carry EXIF with the location, camera serial and time;
// none of it is needed to show a picture. No new dependency: the files are walked segment by segment.
//
// removeImageMetadata(bytes, type) returns the bytes to store, or null when the file must be refused:
// - JPEG: drops APP1-APP15 (EXIF, XMP, IPTC/Photoshop, ...) except an ICC profile in APP2, the MPF index and
//   COM; keeps everything up to the first image's end (EOI). Phones append extra images (depth maps, HDR
//   gain maps) after it, each with its own EXIF, so those are cut.
// - PNG: drops tEXt, zTXt, iTXt, eXIf and tIME chunks.
// - WebP: drops the EXIF and XMP chunks and clears their flags in VP8X.
// - A file that cannot be walked (truncated, unusual, HEIC) is stored unchanged only if it holds no metadata
//   marker; otherwise it is refused. A walked result that still holds an EXIF or XMP marker is refused too.

const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1');
const XMP_NAMESPACE = Buffer.from('http://ns.adobe.com/xap/', 'latin1');
const XMP_PACKET = Buffer.from('<x:xmpmeta', 'latin1');
const PHOTOSHOP_IRB = Buffer.from('Photoshop 3.0\0', 'latin1');
// Long, specific markers: practically never part of compressed image data.
const STRONG_MARKERS = [EXIF_HEADER, XMP_NAMESPACE, XMP_PACKET, PHOTOSHOP_IRB];
// For files that could not be walked, the chunk names of PNG and WebP metadata as well.
const ANY_MARKERS = [...STRONG_MARKERS, Buffer.from('eXIf'), Buffer.from('tEXt'), Buffer.from('iTXt'), Buffer.from('zTXt'), Buffer.from('EXIF'), Buffer.from('XMP ')];

const holdsAny = (bytes, markers) => markers.some((marker) => bytes.includes(marker));

const ICC_PROFILE = Buffer.from('ICC_PROFILE\0', 'latin1');

/** JPEG without metadata segments and without data after the first image's EOI; null if it cannot be walked. */
export const stripJpeg = (bytes) => {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const parts = [bytes.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) { offset += 1; continue; } // fill byte
    if (marker === 0xd9) return null; // EOI before any image data
    if (marker === 0xda) {
      // Start of scan: compressed data follows. FF is always followed by 00 (stuffing), D0-D7 (restart) or a
      // marker, so the first FF D9 is the end of this image.
      for (let i = offset + 2; i + 1 < bytes.length; i += 1) {
        if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) {
          parts.push(bytes.subarray(offset, i + 2));
          return Buffer.concat(parts);
        }
      }
      return null; // no end of image
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    const segment = bytes.subarray(offset, offset + 2 + length);
    const isApp = marker >= 0xe1 && marker <= 0xef;
    const isIcc = marker === 0xe2 && segment.subarray(4, 4 + ICC_PROFILE.length).equals(ICC_PROFILE);
    const isMetadata = (isApp && !isIcc) || marker === 0xfe;
    if (!isMetadata) parts.push(segment);
    offset += 2 + length;
  }
  return null;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_METADATA_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

/** PNG without text, EXIF and time chunks; null if it cannot be walked to IEND. */
export const stripPng = (bytes) => {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const parts = [bytes.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > bytes.length) return null;
    if (!PNG_METADATA_CHUNKS.has(type)) parts.push(bytes.subarray(offset, end));
    offset = end;
    if (type === 'IEND') return Buffer.concat(parts);
  }
  return null;
};

const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;

/** WebP without EXIF and XMP chunks (and their VP8X flags); null if it cannot be walked. */
export const stripWebp = (bytes) => {
  if (bytes.length < 12 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunks = [];
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('latin1', offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    let end = offset + 8 + size + (size & 1);
    if (end > bytes.length) {
      if (offset + 8 + size === bytes.length) end = bytes.length; // last chunk without its pad byte
      else return null;
    }
    if (type !== 'EXIF' && type !== 'XMP ') {
      const chunk = Buffer.from(bytes.subarray(offset, end));
      if (type === 'VP8X' && size >= 1) chunk[8] &= ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG);
      chunks.push(chunk);
    }
    offset = end;
  }
  if (offset !== bytes.length || chunks.length === 0) return null;
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(4 + body.length, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
};

const STRIPPERS = { jpeg: stripJpeg, png: stripPng, webp: stripWebp };

/**
 * The bytes to store for an uploaded photo of a detected type (jpeg, png, webp, heic), with metadata removed,
 * or null when metadata cannot be removed safely (the upload is then refused).
 */
export const removeImageMetadata = (bytes, type) => {
  const stripped = STRIPPERS[type]?.(bytes) ?? null;
  if (stripped) return holdsAny(stripped, STRONG_MARKERS) ? null : stripped;
  return holdsAny(bytes, ANY_MARKERS) ? null : bytes;
};
