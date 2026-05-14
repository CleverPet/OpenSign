import axios from 'axios';
import fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * Backs up signed documents to Google Drive.
 *
 * Auth: uses a GCP service account (no token expiry).
 * Env vars required:
 *   GDRIVE_SA_KEY              — JSON string of the service account key file
 *   GDRIVE_MAIN_FOLDER_ID     — root of A-Z entity folders (main archive)
 *   GDRIVE_AFFILIATE_FOLDER_ID — root of A-Z entity folders (affiliate-only shortcuts)
 *   GDRIVE_SHARED_DRIVE_ID    — (optional) shared drive ID if folders are in a shared drive
 *
 * Falls back to legacy OAuth (GDRIVE_CLIENT_ID/SECRET/REFRESH_TOKEN) if GDRIVE_SA_KEY is not set.
 *
 * Behavior: append-only. Never deletes or modifies existing files/folders.
 *   Folder structure: {root}/{LETTER}/{Last, First}/{YYYY-MM-DD Last, First AgreementName [v]}/
 *   Files created: signed.pdf, metadata.json
 *   Affiliate agreements: a Drive shortcut is created in the affiliate folder pointing to the main agreement folder.
 */

let cachedToken = null;
let tokenExpiresAt = 0;

function buildServiceAccountJwt(saKey) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss: saKey.client_email,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), saKey.private_key);
  return `${signingInput}.${signature.toString('base64url')}`;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  // Prefer service account auth (never expires)
  if (process.env.GDRIVE_SA_KEY) {
    const saKey = JSON.parse(process.env.GDRIVE_SA_KEY);
    const jwt = buildServiceAccountJwt(saKey);
    const { data } = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + data.expires_in * 1000;
    return cachedToken;
  }

  // Legacy fallback: OAuth refresh token
  const { data } = await axios.post(
    'https://oauth2.googleapis.com/token',
    new URLSearchParams({
      client_id: process.env.GDRIVE_CLIENT_ID,
      client_secret: process.env.GDRIVE_CLIENT_SECRET,
      refresh_token: process.env.GDRIVE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

async function driveApi(path, opts = {}) {
  const token = await getAccessToken();
  const url = path.startsWith('http') ? path : `https://www.googleapis.com/drive/v3/${path}`;
  const sharedDriveParams = process.env.GDRIVE_SHARED_DRIVE_ID
    ? { supportsAllDrives: true, includeItemsFromAllDrives: true }
    : {};
  const config = {
    url,
    method: opts.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, ...opts.headers },
    params: { ...sharedDriveParams, ...opts.params },
    data: opts.data,
    responseType: opts.responseType || 'json',
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  };
  const res = await axios(config);
  return res.data;
}

async function findChildFolder(parentId, name) {
  const safeName = name.replace(/'/g, "\\'");
  const q = `mimeType='application/vnd.google-apps.folder' and trashed=false and '${parentId}' in parents and name='${safeName}'`;
  const res = await driveApi('files', {
    params: {
      q,
      fields: 'files(id,name)',
      corpora: process.env.GDRIVE_SHARED_DRIVE_ID ? 'drive' : 'user',
      ...(process.env.GDRIVE_SHARED_DRIVE_ID ? { driveId: process.env.GDRIVE_SHARED_DRIVE_ID } : {}),
    },
  });
  return res.files?.[0] || null;
}

async function createFolder(parentId, name) {
  return driveApi('files', {
    method: 'POST',
    data: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    params: { fields: 'id,name' },
  });
}

async function findOrCreateFolder(parentId, name) {
  const existing = await findChildFolder(parentId, name);
  if (existing) return existing;
  return createFolder(parentId, name);
}

async function uploadFile(parentId, name, buffer, mimeType) {
  const token = await getAccessToken();
  const metadata = { name, parents: [parentId] };
  const boundary = '-------fluentpet-sign-' + Math.random().toString(36).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const sharedParams = process.env.GDRIVE_SHARED_DRIVE_ID ? '&supportsAllDrives=true' : '';
  const { data } = await axios.post(
    `https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name${sharedParams}`,
    body,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
    }
  );
  return data;
}

async function createShortcut(parentId, name, targetId) {
  return driveApi('files', {
    method: 'POST',
    data: {
      name,
      parents: [parentId],
      mimeType: 'application/vnd.google-apps.shortcut',
      shortcutDetails: { targetId },
    },
    params: { fields: 'id,name' },
  });
}

function parseSignerName(fullName) {
  if (!fullName) return { last: 'Unknown', first: '', display: 'Unknown' };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) {
    return { last: parts[0], first: '', display: parts[0] };
  }
  const last = parts[parts.length - 1];
  const first = parts.slice(0, -1).join(' ');
  return { last, first, display: `${last}, ${first}` };
}

function sanitizeFilename(name) {
  return String(name).replace(/[\/\\?%*:|"<>\x00-\x1f]/g, '').trim().slice(0, 200);
}

/**
 * Main entry point: backup a signed document to Drive.
 * @param {Object} params
 * @param {string} params.docId - Parse document objectId
 * @param {string} params.documentName - Name of the agreement (e.g. "Fluentpet Affiliate Agreement")
 * @param {string} params.signerName - Full name of the signer
 * @param {string} params.signerEmail - Email of the signer
 * @param {Buffer} params.pdfBuffer - Signed PDF content
 * @param {Object} params.metadata - Additional metadata to write as JSON
 * @param {string} [params.version] - Optional version string
 */
export async function backupToDrive(params) {
  const mainFolderId = process.env.GDRIVE_MAIN_FOLDER_ID;
  const affiliateFolderId = process.env.GDRIVE_AFFILIATE_FOLDER_ID;
  if (!mainFolderId) {
    console.log('[gdrive-backup] Skipped: GDRIVE_MAIN_FOLDER_ID not set');
    return { skipped: true, reason: 'not configured' };
  }

  const { last, first, display } = parseSignerName(params.signerName);
  const letter = (last[0] || '#').toUpperCase();
  const isAffiliate = /affiliate/i.test(params.documentName || '');

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const versionSuffix = params.version ? ` ${params.version}` : '';
  const agreementFolderName = sanitizeFilename(
    `${today} ${display} ${params.documentName}${versionSuffix}`
  );

  // Build folder hierarchy in main archive
  const letterFolder = await findOrCreateFolder(mainFolderId, letter);
  const entityFolder = await findOrCreateFolder(letterFolder.id, display);
  // Agreement folder: append (2), (3) etc. if name collides (append-only guarantee)
  let agreementFolder;
  let suffix = 0;
  while (true) {
    const candidateName = suffix === 0 ? agreementFolderName : `${agreementFolderName} (${suffix + 1})`;
    const existing = await findChildFolder(entityFolder.id, candidateName);
    if (!existing) {
      agreementFolder = await createFolder(entityFolder.id, candidateName);
      break;
    }
    suffix++;
    if (suffix > 20) {
      agreementFolder = existing; // fallback
      break;
    }
  }

  // Upload signed PDF and metadata
  const pdfName = sanitizeFilename(`${today} ${display} ${params.documentName}.pdf`);
  await uploadFile(agreementFolder.id, pdfName, params.pdfBuffer, 'application/pdf');

  const metadataJson = JSON.stringify(
    {
      ...params.metadata,
      documentId: params.docId,
      documentName: params.documentName,
      signerName: params.signerName,
      signerEmail: params.signerEmail,
      signedAt: new Date().toISOString(),
      entityLastName: last,
      entityDisplay: display,
      isAffiliate,
    },
    null,
    2
  );
  await uploadFile(
    agreementFolder.id,
    'metadata.json',
    Buffer.from(metadataJson, 'utf8'),
    'application/json'
  );

  // For affiliate agreements, create a shortcut in the affiliate archive
  let shortcutId = null;
  if (isAffiliate && affiliateFolderId) {
    try {
      const affLetterFolder = await findOrCreateFolder(affiliateFolderId, letter);
      const affEntityFolder = await findOrCreateFolder(affLetterFolder.id, display);
      const shortcut = await createShortcut(
        affEntityFolder.id,
        agreementFolder.name,
        agreementFolder.id
      );
      shortcutId = shortcut.id;
    } catch (err) {
      console.log('[gdrive-backup] Failed to create affiliate shortcut:', err.message);
    }
  }

  console.log(
    `[gdrive-backup] Backed up '${params.documentName}' for '${display}' to folder ${agreementFolder.id}` +
      (shortcutId ? ` (affiliate shortcut: ${shortcutId})` : '')
  );

  return {
    folderId: agreementFolder.id,
    folderName: agreementFolder.name,
    shortcutId,
    isAffiliate,
  };
}
