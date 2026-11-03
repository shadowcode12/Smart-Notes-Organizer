import { auth, db, storage, firebaseReady, isLocalFallbackError } from '../config/firebase-config.js';
import { addDoc, collection, getDoc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, doc, getDocs, where, writeBatch } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js';

const api = window.SmartNotes ||= {};
const ext = name => name.split('.').pop().toLowerCase();
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const CHUNK_BYTES = 500 * 1024;
const MAX_CHUNKS = 15;
const SEARCH_TERM_LIMIT = 40;
const acceptedExtensions = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx', 'jpg', 'jpeg', 'png', 'gif', 'webp']);
const NOTES_KEY = 'smartnotes-local-notes';
let localMode = !firebaseReady;
let unsubscribeNotes;
let currentNotes = [];
let currentFilters = {};
const isSampleNote = note => note?.isSample === true || note?.sample === true || note?.uploaderName === 'SmartNotes team';
const readNotes = () => { try { return (JSON.parse(localStorage.getItem(NOTES_KEY)) || []).filter(note => !isSampleNote(note)); } catch { return []; } };
const saveNotes = notes => localStorage.setItem(NOTES_KEY, JSON.stringify(notes.filter(note => !isSampleNote(note))));
const activeUser = () => localMode ? api.auth?.currentUser?.() : auth?.currentUser;
const sanitizeText = (value, max = 500) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const safeTags = value => (Array.isArray(value) ? value : String(value || '').split(',')).map(item => sanitizeText(item, 40)).filter(Boolean).slice(0, 20);
const showLoading = loading => document.querySelector('#community-feed')?.classList.toggle('is-loading', loading);
const openFileDb = () => new Promise((resolve, reject) => { const request = indexedDB.open('smartnotes-files', 2); request.onupgradeneeded = () => { const database = request.result; if (!database.objectStoreNames.contains('chunks')) database.createObjectStore('chunks'); if (!database.objectStoreNames.contains('smartnotes_files')) database.createObjectStore('smartnotes_files'); }; request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
const storeLocalChunks = async (noteId, chunks) => { const database = await openFileDb(); await new Promise((resolve, reject) => { const tx = database.transaction('chunks', 'readwrite'); tx.objectStore('chunks').put(chunks, noteId); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); database.close(); };
const readLocalChunks = async noteId => { const database = await openFileDb(); const result = await new Promise((resolve, reject) => { const request = database.transaction('chunks').objectStore('chunks').get(noteId); request.onsuccess = () => resolve(request.result || []); request.onerror = () => reject(request.error); }); database.close(); return result; };
const storeLocalFile = async (noteId, dataUrl) => { const database = await openFileDb(); await new Promise((resolve, reject) => { const tx = database.transaction('smartnotes_files', 'readwrite'); tx.objectStore('smartnotes_files').put({ dataUrl }, noteId); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); database.close(); };
const readLocalFile = async noteId => { const database = await openFileDb(); const result = await new Promise((resolve, reject) => { const request = database.transaction('smartnotes_files').objectStore('smartnotes_files').get(noteId); request.onsuccess = () => resolve(request.result?.dataUrl || ''); request.onerror = () => reject(request.error); }); database.close(); return result; };
const deleteLocalChunks = async noteId => { const database = await openFileDb(); await new Promise((resolve, reject) => { const tx = database.transaction(['chunks', 'smartnotes_files'], 'readwrite'); tx.objectStore('chunks').delete(noteId); tx.objectStore('smartnotes_files').delete(noteId); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); database.close(); };
const fileToDataUrl = file => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error(`Could not read ${file.name}.`)); reader.readAsDataURL(file); });
const enableLocalMode = error => { localMode = true; console.warn('Notes switched to local mode.', error); };
const noteMetadata = (file, dataUrl, metadata) => {
  const user = activeUser();
  const payload = String(dataUrl).split(',')[1] || '';
  const chunkCount = Math.ceil(payload.length / CHUNK_BYTES);
  if (file.size > MAX_FILE_SIZE) throw new Error('File size exceeds the 5 MB maximum limit.');
  if (chunkCount > MAX_CHUNKS) throw new Error('File is too large when chunked.');
  return {
    id: crypto.randomUUID(),
    title: sanitizeText(metadata.title || file.name, 120),
    description: sanitizeText(metadata.description, 500),
    subject: sanitizeText(metadata.subject, 80),
    tags: safeTags(metadata.tags),
    fileName: sanitizeText(file.name, 180),
    mimeType: file.type || 'application/octet-stream',
    fileSize: file.size,
    size: file.size,
    extension: ext(file.name),
    contentType: file.type || 'application/octet-stream',
    uploaderId: user.uid,
    uploaderName: sanitizeText(user.displayName || user.email || 'Student', 120),
    createdAt: Date.now(),
    storageMode: 'chunks',
    isChunked: true,
    chunkCount
  };
};
async function saveLargeFileChunks(noteId, dataUrl) {
  const payload = String(dataUrl).split(',')[1] || '';
  const chunkCount = Math.ceil(payload.length / CHUNK_BYTES);
  const chunks = Array.from({ length: chunkCount }, (_, index) => payload.slice(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES));
  await storeLocalFile(noteId, dataUrl);
  if (localMode) {
    await storeLocalChunks(noteId, chunks);
    return chunkCount;
  }
  const batch = writeBatch(db);
  for (let index = 0; index < chunkCount; index += 1) {
    const chunkRef = doc(db, 'notes', noteId, 'chunks', String(index));
    batch.set(chunkRef, { index, data: chunks[index] });
  }
  await batch.commit();
  return chunkCount;
}
// Thumbnails are generated in the browser. A failure just means no thumbnail; the upload still succeeds.
const THUMB_MAX = 320;
const PDFJS_VERSION = '3.11.174';
const THUMB_IMAGE_TYPES = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);
let pdfJsPromise;
const loadPdfJs = () => {
  if (!pdfJsPromise) {
    pdfJsPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.min.js`;
      script.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}/pdf.worker.min.js`;
        resolve(window.pdfjsLib);
      };
      script.onerror = () => { pdfJsPromise = null; reject(new Error('Could not load the PDF preview library.')); };
      document.head.append(script);
    });
  }
  return pdfJsPromise;
};
const thumbScale = (width, height) => THUMB_MAX / Math.max(width, height);
const canvasToThumb = canvas => canvas.toDataURL('image/jpeg', 0.75);
const imageThumbnail = async file => {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, thumbScale(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return canvasToThumb(canvas);
};
const pdfThumbnail = async file => {
  const pdfjs = await loadPdfJs();
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise;
  const page = await pdf.getPage(1);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: thumbScale(base.width, base.height) });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(viewport.width));
  canvas.height = Math.max(1, Math.round(viewport.height));
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvasToThumb(canvas);
};
const makeThumbnail = async file => {
  try {
    const type = ext(file.name);
    if (THUMB_IMAGE_TYPES.has(type)) return await imageThumbnail(file);
    if (type === 'pdf') return await pdfThumbnail(file);
  } catch (error) {
    console.warn('Thumbnail skipped for', file.name, error);
  }
  return '';
};
const mapNoteSnapshot = docSnap => { const data = docSnap.data(); return { ...data, localId: data.id || docSnap.id, id: docSnap.id, firestoreDocId: docSnap.id }; };
// Cloud Storage path is owner-scoped so storage.rules can check the uid in the path.
const safeStorageName = name => sanitizeText(name, 180).replace(/[\/\\"]/g, '_') || 'file';
async function uploadToStorage(uid, noteId, file) {
  if (!storage) return '';
  const path = `notes/${uid}/${noteId}/${safeStorageName(file.name)}`;
  try {
    await uploadBytes(ref(storage, path), file, { contentType: file.type || 'application/octet-stream', contentDisposition: 'attachment' });
    return path;
  } catch (error) {
    console.warn('Storage upload unavailable; saving file as Firestore chunks instead.', error);
    return '';
  }
}
async function removeStoredFile(path) {
  if (!storage || !path) return;
  try { await deleteObject(ref(storage, path)); } catch (error) { console.warn('Could not remove stored file.', error); }
}
export async function uploadNote(file, metadata = {}) {
  if (!activeUser()) throw new Error('Sign in to upload notes.');
  if (!localMode && !activeUser().emailVerified) throw new Error('Verify your email address before uploading. Check your inbox for the verification link.');
  if (!acceptedExtensions.has(ext(file.name))) throw new Error('This file type is not supported.');
  if (file.size > MAX_FILE_SIZE) throw new Error('File size exceeds the 5 MB limit.');
  const dataUrl = await fileToDataUrl(file);
  const note = noteMetadata(file, dataUrl, metadata);
  note.searchTerms = buildSearchTerms(note);
  const thumbnail = await makeThumbnail(file);
  if (thumbnail) note.thumbnail = thumbnail;
  if (localMode) {
    saveNotes([note, ...readNotes()]);
    await saveLargeFileChunks(note.id, dataUrl);
    return note;
  }
  try {
    const noteRef = doc(collection(db, 'notes'));
    note.id = noteRef.id;
    note.firestoreDocId = noteRef.id;
    // Prefer Cloud Storage for the file bytes. If Storage is not enabled or the upload fails, keep the chunked fallback.
    const storagePath = await uploadToStorage(activeUser().uid, noteRef.id, file);
    if (storagePath) Object.assign(note, { storageMode: 'storage', storagePath, isChunked: false, chunkCount: 0 });
    const batch = writeBatch(db);
    batch.set(noteRef, { ...note, createdAt: serverTimestamp() });
    try {
      await batch.commit();
    } catch (commitError) {
      if (storagePath) await removeStoredFile(storagePath);
      throw commitError;
    }
    if (!storagePath) await saveLargeFileChunks(noteRef.id, dataUrl);
    return note;
  } catch (error) {
    if (!isLocalFallbackError(error)) throw error;
    enableLocalMode(error);
    return uploadNote(file, metadata);
  }
}
const filterNotes = (notes, filters) => { const term = sanitizeText(filters.search, 120).toLowerCase(); return notes.filter(note => (!filters.subject || note.subject === filters.subject) && (!filters.extension || note.extension === filters.extension) && (!filters.mine || note.uploaderId === activeUser()?.uid) && (!term || [note.title, note.description, note.subject, note.uploaderName, ...(note.tags || [])].join(' ').toLowerCase().includes(term))); };
// Lowercase search tokens stored on each note, so Firestore can find notes outside the loaded feed.
export const buildSearchTerms = note => {
  const text = [note.title, note.description, note.subject, note.uploaderName, note.extension, ...(note.tags || [])].join(' ').toLowerCase();
  const terms = text.split(/[^\p{L}\p{N}]+/u).filter(term => term.length >= 2 && term.length <= 40);
  return [...new Set(terms)].slice(0, SEARCH_TERM_LIMIT);
};
const searchNotesRemote = async term => {
  const tokens = buildSearchTerms({ title: term });
  if (!tokens.length) return [];
  const snapshot = await getDocs(query(collection(db, 'notes'), where('searchTerms', 'array-contains', tokens[0]), orderBy('createdAt', 'desc'), limit(100)));
  return snapshot.docs.map(mapNoteSnapshot).filter(note => !isSampleNote(note));
};
export async function listCommunityNotes(filters = {}) {
  currentFilters = filters;
  if (localMode) return filterNotes(readNotes(), filters);
  const loaded = filterNotes(currentNotes, filters);
  const term = sanitizeText(filters.search, 120);
  if (!term) return loaded;
  let remote = [];
  try {
    remote = filterNotes(await searchNotesRemote(term), filters);
  } catch (error) {
    console.warn('Database search unavailable; showing loaded notes only.', error);
  }
  const seen = new Set(loaded.map(note => note.id));
  return [...loaded, ...remote.filter(note => !seen.has(note.id))];
}
// Shows the signed-in user's real upload totals (count, size, last upload date) in the sidebar.
const toMillis = value => (typeof value?.toMillis === 'function' ? value.toMillis() : Number(value) || 0);
export async function updateUploadUsage() {
  const targets = document.querySelectorAll('[data-upload-usage]');
  if (!targets.length) return;
  const user = activeUser();
  if (!user) {
    targets.forEach(el => { el.querySelector('[data-usage-total]').textContent = 'Sign in to see uploads'; el.querySelector('[data-usage-detail]').textContent = ''; });
    return;
  }
  let mine = [];
  try {
    if (localMode) mine = readNotes().filter(note => note.uploaderId === user.uid);
    else {
      const snapshot = await getDocs(query(collection(db, 'notes'), where('uploaderId', '==', user.uid)));
      mine = snapshot.docs.map(docSnap => docSnap.data());
    }
  } catch (error) {
    console.warn('Could not load upload totals.', error);
  }
  const bytes = mine.reduce((sum, note) => sum + (Number(note.fileSize ?? note.size) || 0), 0);
  const latest = Math.max(0, ...mine.map(note => toMillis(note.createdAt)));
  const count = `${mine.length} file${mine.length === 1 ? '' : 's'}`;
  const total = mine.length ? `${(bytes / 1048576).toFixed(1)} MB · ${count}` : 'No uploads yet';
  const detail = latest ? `Last upload ${new Date(latest).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` : 'Upload a file to start';
  targets.forEach(el => { el.querySelector('[data-usage-total]').textContent = total; el.querySelector('[data-usage-detail]').textContent = detail; });
}
export async function renderMyUploadedNotes(container = document.querySelector('#my-uploaded-notes-grid')) { updateUploadUsage(); if (!container) return []; const notes = filterNotes(localMode ? readNotes() : currentNotes, { mine: true }); container.replaceChildren(); if (!notes.length) { const empty = document.createElement('p'); empty.className = 'empty-state empty-state-card'; empty.textContent = 'You have not uploaded any study notes yet.'; container.append(empty); return notes; } notes.forEach(note => container.append(createCard(note))); return notes; }
const showDownloadToast = text => { const toast = document.createElement('div'); toast.className = 'download-toast'; toast.textContent = text; Object.assign(toast.style, { position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)', zIndex: '10000', padding: '12px 18px', borderRadius: '999px', background: '#172033', color: '#fff' }); document.body.append(toast); setTimeout(() => toast.remove(), 3000); };
const handleDownload = async note => { if (!activeUser()) { window.location.href = window.location.pathname.includes('/pages/') ? 'login.html' : 'pages/login.html'; return; } showDownloadToast('Downloading file...'); try { await downloadNoteFile(note); } catch (error) { showDownloadToast(error.message); } };
const createCard = note => { const card = document.createElement('article'); card.className = 'note-card-community'; const preview = document.createElement('div'); preview.className = `note-preview preview-${note.extension || 'pdf'}`; if (note.thumbnail) { const img = document.createElement('img'); img.src = note.thumbnail; img.alt = ''; img.loading = 'lazy'; Object.assign(img.style, { width: '100%', height: '100%', objectFit: 'cover', display: 'block' }); preview.append(img); } else { preview.textContent = (note.extension || 'PDF').toUpperCase(); } card.append(preview); const title = document.createElement('h3'); title.textContent = note.title || 'Untitled note'; card.append(title); const description = document.createElement('p'); description.textContent = note.description || 'Shared study guide from a campus classmate.'; card.append(description); const meta = document.createElement('div'); meta.className = 'note-meta';[note.subject || 'General', (note.extension || '').toUpperCase(), `By ${note.uploaderName || 'Anonymous'}`].forEach(value => { const span = document.createElement('span'); span.textContent = value; meta.append(span); }); card.append(meta); const actions = document.createElement('div'); actions.className = 'note-card-actions'; const download = document.createElement('button'); download.className = 'button primary btn-download'; download.type = 'button'; download.textContent = 'Free Download'; download.dataset.downloadNote = note.id; download.addEventListener('click', () => handleDownload(note)); actions.append(download); if (note.uploaderId !== activeUser()?.uid) { const message = document.createElement('button'); message.className = 'button secondary'; message.type = 'button'; message.textContent = 'Message author'; message.addEventListener('click', () => window.SmartNotes.chat?.openChat(note.uploaderId, note.uploaderName)); actions.append(message); } else { const remove = document.createElement('button'); remove.className = 'button secondary danger-button'; remove.type = 'button'; remove.textContent = 'Delete'; remove.addEventListener('click', async () => { if (confirm('Delete this note permanently?')) { remove.disabled = true; try { await deleteNote(note); await renderMyUploadedNotes(); } catch (error) { remove.disabled = false; alert(error.message); } } }); actions.append(remove); } card.append(actions); return card; };
export async function renderCommunityFeed(container = document.querySelector('#community-feed'), filters = currentFilters) { if (!container) return []; showLoading(true); try { const notes = await listCommunityNotes(filters); container.replaceChildren(); if (!notes.length) { const empty = document.createElement('p'); empty.className = 'empty-state empty-state-card'; empty.textContent = 'No study notes uploaded yet. Be the first student to share a resource!'; container.append(empty); } else notes.forEach(note => container.append(createCard(note))); return notes; } catch (error) { container.textContent = error.message; return []; } finally { showLoading(false); } }
export function subscribeCommunityNotes(container = document.querySelector('#community-feed')) { if (localMode) { renderCommunityFeed(container); return () => { }; } unsubscribeNotes?.(); showLoading(true); unsubscribeNotes = onSnapshot(query(collection(db, 'notes'), orderBy('createdAt', 'desc'), limit(200)), snapshot => { currentNotes = snapshot.docs.map(mapNoteSnapshot).filter(note => !isSampleNote(note)); renderCommunityFeed(container, currentFilters); }, error => { if (isLocalFallbackError(error)) { enableLocalMode(error); renderCommunityFeed(container, currentFilters); } else { if (container) container.textContent = 'Unable to load community notes.'; showLoading(false); console.error(error); } }); return unsubscribeNotes; }
async function resolveFirestoreDocId(noteId) { const snapshot = await getDocs(query(collection(db, 'notes'), where('id', '==', noteId))); return snapshot.docs[0]?.id || ''; }
async function getChunkedDataUrl(note) { const cacheKey = note.firestoreDocId || note.id; const cached = await readLocalFile(cacheKey); if (cached) return cached; if (localMode) { const chunks = await readLocalChunks(cacheKey); if (!chunks.length) throw new Error('File data is unavailable.'); const dataUrl = `data:${note.mimeType || note.contentType || 'application/pdf'};base64,${chunks.join('')}`; await storeLocalFile(cacheKey, dataUrl); return dataUrl; } let docId = note.firestoreDocId || note.id; let chunkSnapshot = await getDocs(collection(db, 'notes', docId, 'chunks')); if (!chunkSnapshot.docs.length && note.id) { const realDocId = await resolveFirestoreDocId(note.id); if (realDocId && realDocId !== docId) { docId = realDocId; chunkSnapshot = await getDocs(collection(db, 'notes', docId, 'chunks')); } } const chunks = chunkSnapshot.docs.map(item => ({ ...item.data(), documentId: item.id })).sort((a, b) => Number(a.index ?? a.documentId) - Number(b.index ?? b.documentId)).map(chunk => chunk.data || chunk.content || chunk.base64 || ''); if (!chunks.length) throw new Error('File data is unavailable.'); const dataUrl = `data:${note.mimeType || note.contentType || 'application/pdf'};base64,${chunks.join('')}`; await storeLocalFile(cacheKey, dataUrl); return dataUrl; }
export async function getNoteDataUrl(note) { if (note.fileDataUrl) return note.fileDataUrl; if (note.isChunked || note.storageMode === 'chunks' || note.chunkCount || note.chunks) return getChunkedDataUrl(note); throw new Error('This earlier test note has no attached file data. Please re-upload the file to test downloading.'); }
async function findNote(noteIdOrNote) { if (typeof noteIdOrNote !== 'string') return noteIdOrNote; const found = currentNotes.find(note => note.id === noteIdOrNote || note.localId === noteIdOrNote) || readNotes().find(note => note.id === noteIdOrNote || note.localId === noteIdOrNote); if (found) return found; const cached = await readLocalFile(noteIdOrNote); if (cached) return { id: noteIdOrNote, fileDataUrl: cached }; if (!localMode) { const snapshot = await getDoc(doc(db, 'notes', noteIdOrNote)); if (snapshot.exists()) return mapNoteSnapshot(snapshot); const realDocId = await resolveFirestoreDocId(noteIdOrNote); if (realDocId) return mapNoteSnapshot(await getDoc(doc(db, 'notes', realDocId))); } throw new Error('This earlier test note has no attached file data. Please re-upload the file to test downloading.'); }
const base64Bytes = value => Uint8Array.from(atob(String(value).split(',').pop().replace(/\s/g, '')), character => character.charCodeAt(0));
export async function downloadNoteFile(noteIdOrNote) { if (!activeUser()) throw new Error('Sign in before downloading notes.'); const note = await findNote(noteIdOrNote); if (note.storagePath) { if (!storage) throw new Error('File storage is unavailable right now. Please try again later.'); const url = await getDownloadURL(ref(storage, note.storagePath)); const anchor = document.createElement('a'); anchor.href = url; anchor.rel = 'noopener'; document.body.append(anchor); anchor.click(); anchor.remove(); return; } const dataUrl = await getNoteDataUrl(note); const blob = new Blob([base64Bytes(dataUrl)], { type: note.mimeType || note.contentType || 'application/pdf' }); const blobUrl = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = blobUrl; anchor.download = note.fileName || note.title || `${note.id || 'note'}.${note.fileExt || note.extension || 'pdf'}`; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(blobUrl), 10000); }
export async function downloadNote(note, callback) { try { await downloadNoteFile(note); callback?.(null); } catch (error) { callback?.(error); throw error; } }
export async function deleteNote(note) {
  const user = activeUser();
  if (!user || user.uid !== note.uploaderId) throw new Error('Only the note author can delete this note.');
  if (localMode) {
    saveNotes(readNotes().filter(item => item.id !== note.id));
    await deleteLocalChunks(note.id);
    renderCommunityFeed();
    return;
  }
  let docId = note.firestoreDocId || note.id;
  let noteSnapshot = await getDoc(doc(db, 'notes', docId));
  if (!noteSnapshot.exists() && note.id) {
    docId = await resolveFirestoreDocId(note.id);
    if (!docId) throw new Error('The note could not be found.');
    noteSnapshot = await getDoc(doc(db, 'notes', docId));
  }
  const storedPath = noteSnapshot.data()?.storagePath || note.storagePath;
  const chunks = await getDocs(collection(db, 'notes', docId, 'chunks'));
  const batch = writeBatch(db);
  chunks.docs.forEach(item => batch.delete(item.ref));
  batch.delete(doc(db, 'notes', docId));
  await batch.commit();
  await removeStoredFile(storedPath);
}
export function bindUploadWidget(widget = document.querySelector('[data-upload-widget]')) {
  if (!widget || widget.dataset.firebaseUploadBound) return;
  widget.dataset.firebaseUploadBound = 'true';
  const input = widget.querySelector('#study-file-input, .file-input');
  const dropZone = widget.querySelector('.upload-dropzone, .drop-zone');
  const status = widget.querySelector('.upload-status');
  const list = widget.querySelector('.file-list');
  const publish = widget.querySelector('[data-publish-note]');
  let selectedFiles = [];
  const fields = selector => widget.querySelector(selector)?.value || '';
  const renderFiles = () => { if (!list) return; list.replaceChildren(); selectedFiles.forEach((file, index) => { const item = document.createElement('li'); item.className = 'file-item'; const badge = document.createElement('span'); badge.className = 'file-badge'; badge.textContent = ext(file.name).toUpperCase(); const detail = document.createElement('span'); detail.className = 'file-details'; const name = document.createElement('strong'); name.textContent = file.name; const size = document.createElement('small'); size.textContent = `${Math.max(1, Math.round(file.size / 1024))} KB`; detail.append(name, size); const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${file.name}`); remove.addEventListener('click', () => { selectedFiles.splice(index, 1); renderFiles(); }); item.append(badge, detail, remove); list.append(item); }); };
  const selectFiles = files => { const accepted = Array.from(files).filter(file => acceptedExtensions.has(ext(file.name))); selectedFiles = [...selectedFiles, ...accepted.filter(file => !selectedFiles.some(existing => existing.name === file.name && existing.size === file.size))]; renderFiles(); if (status) { status.textContent = selectedFiles.length ? `${selectedFiles.length} file${selectedFiles.length === 1 ? '' : 's'} ready to publish.` : ''; status.className = 'upload-status success'; } };
  const openPicker = event => { event.preventDefault(); event.stopPropagation(); input?.click(); };
  dropZone?.addEventListener('click', openPicker);
  dropZone?.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') openPicker(event); });
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(type => dropZone?.addEventListener(type, event => { event.preventDefault(); event.stopPropagation(); dropZone.classList.toggle('drag-over', type === 'dragenter' || type === 'dragover'); if (type === 'drop') selectFiles(event.dataTransfer.files); }));
  input?.addEventListener('change', event => selectFiles(event.target.files));
  publish?.addEventListener('click', async () => { if (!activeUser()) { status.textContent = 'Please log in before uploading study files.'; status.className = 'upload-status error'; return; } if (!selectedFiles.length) { status.textContent = 'Choose at least one study file first.'; status.className = 'upload-status error'; return; } publish.disabled = true; widget.classList.add('is-uploading'); try { for (const file of selectedFiles) await uploadNote(file, { title: fields('.note-title'), subject: fields('.note-subject'), tags: fields('.note-tags'), description: fields('.note-description') }); status.textContent = `${selectedFiles.length} note${selectedFiles.length === 1 ? '' : 's'} published successfully.`; status.className = 'upload-status success'; selectedFiles = []; renderFiles(); await subscribeCommunityNotes(); await renderMyUploadedNotes(); } catch (error) { status.textContent = error.message; status.className = 'upload-status error'; } finally { widget.classList.remove('is-uploading'); publish.disabled = false; } });
}
api.notes = { uploadNote, listCommunityNotes, getNoteDataUrl, downloadNote, deleteNote, bindUploadWidget, renderCommunityFeed, renderMyUploadedNotes, subscribeCommunityNotes };
document.querySelectorAll('[data-upload-widget]').forEach(bindUploadWidget);
['#community-search', '#community-subject', '#community-extension', '#community-mine'].forEach(selector => document.querySelector(selector)?.addEventListener('input', () => renderCommunityFeed(undefined, { search: document.querySelector('#community-search')?.value || '', subject: document.querySelector('#community-subject')?.value || '', extension: document.querySelector('#community-extension')?.value || '', mine: document.querySelector('#community-mine')?.checked || false })));
