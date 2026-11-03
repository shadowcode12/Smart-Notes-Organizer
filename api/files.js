// Backend for note files on Backblaze B2. Checks the Firebase sign-in, then returns short-lived
// presigned links so the browser transfers the bytes straight to B2 (Vercel bodies are limited to 4.5 MB).
// Env vars (Vercel dashboard, never commit): B2_KEY_ID, B2_APP_KEY, B2_BUCKET, B2_REGION.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { AwsClient } from 'aws4fetch';

const PROJECT_ID = 'smartnotes-8f51d';
const MAX_BYTES = 5 * 1024 * 1024;
const LINK_SECONDS = 300;
const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const env = name => {
  const value = process.env[name];
  if (!value) throw new HttpError(500, 'File storage is not configured.');
  return value;
};

async function signedInUser(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw new HttpError(401, 'Sign in first.');
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${PROJECT_ID}`,
      audience: PROJECT_ID
    });
    return { uid: payload.user_id || payload.sub, verified: payload.email_verified === true };
  } catch {
    throw new HttpError(401, 'Your sign-in has expired. Please log in again.');
  }
}

const safeName = name => String(name || '').replace(/[\/\\"\u0000-\u001f]/g, '_').trim().slice(0, 180);
const validKey = key => typeof key === 'string' && key.length <= 300 && key.startsWith('notes/') && !key.includes('..');

const objectUrl = key => {
  const path = key.split('/').map(encodeURIComponent).join('/');
  return `https://s3.${env('B2_REGION')}.backblazeb2.com/${env('B2_BUCKET')}/${path}`;
};

// Creates a presigned S3-style link that expires after LINK_SECONDS.
async function presign(method, key, headers = {}) {
  const client = new AwsClient({
    accessKeyId: env('B2_KEY_ID'),
    secretAccessKey: env('B2_APP_KEY'),
    service: 's3',
    region: env('B2_REGION')
  });
  const url = new URL(objectUrl(key));
  url.searchParams.set('X-Amz-Expires', String(LINK_SECONDS));
  const signed = await client.sign(url.toString(), { method, headers, aws: { signQuery: true } });
  return signed.url;
}

export default async function handler(req, res) {
  try {
    const action = req.query?.action;

    if (action === 'upload-url' && req.method === 'POST') {
      const { uid, verified } = await signedInUser(req);
      if (!verified) throw new HttpError(403, 'Verify your email address before uploading.');
      const { noteId, fileName, size, contentType } = req.body || {};
      if (!/^[A-Za-z0-9_-]{5,100}$/.test(noteId || '')) throw new HttpError(400, 'Invalid note id.');
      const bytes = Number(size);
      if (!Number.isInteger(bytes) || bytes <= 0 || bytes > MAX_BYTES) throw new HttpError(400, 'File must be between 1 byte and 5 MB.');
      const name = safeName(fileName);
      if (!name) throw new HttpError(400, 'Invalid file name.');
      const type = typeof contentType === 'string' && contentType.length <= 100 ? contentType : 'application/octet-stream';
      const key = `notes/${uid}/${noteId}/${name}`;
      const url = await presign('PUT', key, { 'content-type': type, 'content-length': String(bytes) });
      return res.status(200).json({ key, url, headers: { 'Content-Type': type } });
    }

    if (action === 'download-url' && req.method === 'GET') {
      await signedInUser(req);
      const key = req.query?.key;
      if (!validKey(key)) throw new HttpError(400, 'Invalid file path.');
      return res.status(200).json({ url: await presign('GET', key) });
    }

    if (action === 'delete-url' && req.method === 'POST') {
      const { uid } = await signedInUser(req);
      const key = req.body?.key;
      if (!validKey(key)) throw new HttpError(400, 'Invalid file path.');
      if (!key.startsWith(`notes/${uid}/`)) throw new HttpError(403, 'You can only delete your own files.');
      return res.status(200).json({ url: await presign('DELETE', key) });
    }

    throw new HttpError(404, 'Not found.');
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(error);
    res.status(status).json({ error: error instanceof HttpError ? error.message : 'Something went wrong. Please try again.' });
  }
}
