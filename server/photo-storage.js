/**
 * Private Supabase Storage adapter for hackathon chat photo evidence.
 * Files remain private; the server supplies bytes after workspace lookup.
 * Demo identities are not authentication; use only non-sensitive test images.
 */
const URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SECRET = process.env.SUPABASE_SECRET_KEY || '';
export const PHOTO_BUCKET = 'shiftbridge-chat';
export const MAX_PHOTO_BYTES = 1_300_000;
export const PHOTO_TYPES = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
});

function objectUrl(path) {
  if (process.env.SHIFTBRIDGE_STORAGE !== 'supabase' || !URL || !SECRET) {
    throw new Error('Photo storage requires configured Supabase mode');
  }
  return URL + '/storage/v1/object/' + PHOTO_BUCKET + '/' +
    path.split('/').map(encodeURIComponent).join('/');
}

function headers(type) {
  return { apikey: SECRET, ...(type ? { 'Content-Type': type } : {}) };
}

export function parsePhoto(base64, contentType) {
  if (!PHOTO_TYPES[contentType]) throw new Error('Only JPEG, PNG and WebP photos are supported');
  if (typeof base64 !== 'string' || base64.length === 0 ||
    base64.length > Math.ceil(MAX_PHOTO_BYTES * 4 / 3) + 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
    throw new Error('Invalid photo data or photo exceeds 1.3 MB');
  }
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES) throw new Error('Photo exceeds 1.3 MB');
  const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const webp = bytes.length > 12 && bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!(contentType === 'image/jpeg' && jpeg) &&
      !(contentType === 'image/png' && png) &&
      !(contentType === 'image/webp' && webp)) {
    throw new Error('The photo content does not match its file type');
  }
  return bytes;
}

export async function uploadPhoto(path, bytes, type) {
  const response = await fetch(objectUrl(path), {
    method: 'POST', headers: { ...headers(type), 'x-upsert': 'false' },
    body: bytes, signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('Private photo upload failed (' + response.status + ')');
}

export async function readPhoto(path) {
  // Private Storage downloads require the authenticated object endpoint.
  const url = objectUrl(path).replace('/storage/v1/object/', '/storage/v1/object/authenticated/');
  const response = await fetch(url, {
    method: 'GET', headers: headers(), signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('Private photo retrieval failed (' + response.status + ')');
  return Buffer.from(await response.arrayBuffer());
}

export async function deletePhoto(path) {
  try {
    await fetch(objectUrl(path), {
      method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    console.error('[storage] Orphan cleanup failed', error.message);
  }
}
