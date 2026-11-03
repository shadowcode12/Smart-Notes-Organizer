import { readFileSync } from 'node:fs';
import { before, after, afterEach, test } from 'node:test';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import {
  doc,
  setDoc,
  getDoc,
  deleteDoc,
  updateDoc,
  writeBatch
} from 'firebase/firestore';

const rules = readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8');
let testEnv;

const user = (uid, emailVerified = true) =>
  testEnv.authenticatedContext(uid, { email_verified: emailVerified }).firestore();
const anon = () => testEnv.unauthenticatedContext().firestore();
const note = (uid = 'uploader') => ({ uploaderId: uid, size: 100, title: 'Valid title' });

// Writes bypassing rules, to set up data the test needs.
const seed = write => testEnv.withSecurityRulesDisabled(async context => write(context.firestore()));

before(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: 'smartnotes-rules-test',
    firestore: { rules }
  });
});

after(async () => {
  await testEnv?.cleanup();
});

afterEach(async () => {
  await testEnv?.clearFirestore();
});

test('public note metadata, but chunks require sign-in', async () => {
  await seed(db => setDoc(doc(db, 'notes/n1'), note()));
  await seed(db => setDoc(doc(db, 'notes/n1/chunks/0'), { data: 'x', index: 0 }));

  await assertSucceeds(getDoc(doc(anon(), 'notes/n1')));
  await assertFails(getDoc(doc(anon(), 'notes/n1/chunks/0')));
  await assertSucceeds(getDoc(doc(user('someone'), 'notes/n1/chunks/0')));
});

test('note creation requires verified owner and valid metadata', async () => {
  await assertFails(setDoc(doc(user('uploader', false), 'notes/n1'), note()));
  await assertFails(setDoc(doc(user('uploader'), 'notes/n2'), { ...note(), uploaderId: 'other' }));
  await assertFails(setDoc(doc(user('uploader'), 'notes/n3'), { ...note(), size: 0 }));
  await assertFails(setDoc(doc(user('uploader'), 'notes/n4'), { ...note(), title: 'x'.repeat(121) }));
  await assertSucceeds(setDoc(doc(user('uploader'), 'notes/n1'), note()));
});

test('chunk indexes, size, fields, and ownership are restricted', async () => {
  await seed(db => setDoc(doc(db, 'notes/n1'), note()));
  const uploader = user('uploader');

  await assertSucceeds(setDoc(doc(uploader, 'notes/n1/chunks/0'), { data: 'x', index: 0 }));
  await assertSucceeds(setDoc(doc(uploader, 'notes/n1/chunks/14'), { data: 'x', index: 14 }));
  await assertFails(setDoc(doc(uploader, 'notes/n1/chunks/15'), { data: 'x', index: 15 }));
  await assertFails(setDoc(doc(uploader, 'notes/n1/chunks/-1'), { data: 'x', index: -1 }));
  await assertFails(setDoc(doc(uploader, 'notes/n1/chunks/1'), { data: 'x', index: 1, extra: true }));
  await assertFails(setDoc(doc(uploader, 'notes/n1/chunks/2'), { data: 'x'.repeat(768001), index: 2 }));
  await assertFails(setDoc(doc(user('other'), 'notes/n1/chunks/3'), { data: 'x', index: 3 }));
});

test('uploader can delete note and chunks in one batch', async () => {
  await seed(async db => {
    await setDoc(doc(db, 'notes/n1'), note());
    await setDoc(doc(db, 'notes/n1/chunks/0'), { data: 'x', index: 0 });
  });

  const db = user('uploader');
  const batch = writeBatch(db);
  batch.delete(doc(db, 'notes/n1/chunks/0'));
  batch.delete(doc(db, 'notes/n1'));
  await assertSucceeds(batch.commit());
});

test('non-uploader cannot delete note or chunks; ownership fields cannot change', async () => {
  await seed(async db => {
    await setDoc(doc(db, 'notes/n1'), note());
    await setDoc(doc(db, 'notes/n1/chunks/0'), { data: 'x', index: 0 });
  });

  const other = user('other');
  await assertFails(deleteDoc(doc(other, 'notes/n1')));
  await assertFails(deleteDoc(doc(other, 'notes/n1/chunks/0')));

  const uploader = user('uploader');
  await assertFails(setDoc(doc(uploader, 'notes/n1'), { ...note(), uploaderId: 'other' }));
  await assertFails(setDoc(doc(uploader, 'notes/n1'), { ...note(), size: 200 }));
  await assertSucceeds(setDoc(doc(uploader, 'notes/n1'), { ...note(), title: 'New title' }));
});

test('conversation participants control messages and immutable fields', async () => {
  await seed(db => setDoc(doc(db, 'conversations/c1'), { participants: ['a', 'b'] }));

  const a = user('a');
  const b = user('b');
  const c = user('c');

  // Valid message from a participant to the other participant.
  await assertSucceeds(
    setDoc(doc(a, 'conversations/c1/messages/m1'), { senderId: 'a', recipientId: 'b', text: 'hi' })
  );

  // Spoofed sender: b's uid used while signed in as a.
  await assertFails(
    setDoc(doc(a, 'conversations/c1/messages/m2'), { senderId: 'b', recipientId: 'a', text: 'spoof' })
  );

  // Recipient is not a participant.
  await assertFails(
    setDoc(doc(a, 'conversations/c1/messages/m4'), { senderId: 'a', recipientId: 'c', text: 'outsider' })
  );

  // Non-participant cannot read or write.
  await assertFails(getDoc(doc(c, 'conversations/c1')));
  await assertFails(
    setDoc(doc(c, 'conversations/c1/messages/m3'), { senderId: 'c', recipientId: 'a', text: 'no' })
  );

  // Messages are append-only.
  await assertFails(updateDoc(doc(a, 'conversations/c1/messages/m1'), { text: 'edited' }));
  await assertFails(deleteDoc(doc(a, 'conversations/c1/messages/m1')));

  // Participants cannot change, but a normal merge that keeps them is allowed (chat.js does this).
  await assertFails(updateDoc(doc(a, 'conversations/c1'), { participants: ['a', 'c'] }));
  await assertSucceeds(
    setDoc(
      doc(b, 'conversations/c1'),
      { participants: ['a', 'b'], lastMessage: 'hi' },
      { merge: true }
    )
  );
});

test('search terms are optional but limited to 40 entries', async () => {
  const uploader = user('uploader');
  await assertSucceeds(
    setDoc(doc(uploader, 'notes/s1'), { ...note(), searchTerms: ['algorithms', 'graphs'] })
  );
  await assertSucceeds(setDoc(doc(uploader, 'notes/s2'), note()));
  await assertFails(
    setDoc(doc(uploader, 'notes/s3'), {
      ...note(),
      searchTerms: Array.from({ length: 41 }, (_, i) => `term${i}`)
    })
  );
  await assertFails(setDoc(doc(uploader, 'notes/s4'), { ...note(), searchTerms: 'not a list' }));
});

test('storage path is optional but must sit in the uploader folder', async () => {
  const uploader = user('uploader');
  await assertSucceeds(
    setDoc(doc(uploader, 'notes/p1'), { ...note(), storagePath: 'notes/uploader/p1/file.pdf' })
  );
  await assertFails(
    setDoc(doc(uploader, 'notes/p2'), { ...note(), storagePath: 'notes/someone-else/p2/file.pdf' })
  );
  await assertFails(setDoc(doc(uploader, 'notes/p3'), { ...note(), storagePath: 42 }));
});

test('thumbnails are optional but limited to 100000 characters', async () => {
  const uploader = user('uploader');
  await assertSucceeds(
    setDoc(doc(uploader, 'notes/t1'), { ...note(), thumbnail: 'data:image/jpeg;base64,abc' })
  );
  await assertFails(
    setDoc(doc(uploader, 'notes/t2'), { ...note(), thumbnail: 'x'.repeat(100001) })
  );
  await assertFails(setDoc(doc(uploader, 'notes/t3'), { ...note(), thumbnail: 12345 }));
});
test("a user can report a note once, with the id <uid>_<noteId>", async () => {
  const reporter = user("reporter");
  const valid = { reporterId: "reporter", noteId: "n1", reason: "Spam", createdAt: new Date() };
  await assertSucceeds(setDoc(doc(reporter, "reports/reporter_n1"), valid));
  await assertFails(setDoc(doc(reporter, "reports/reporter_n1"), valid));
  await assertFails(setDoc(doc(reporter, "reports/someone_n1"), valid));
  await assertFails(setDoc(doc(reporter, "reports/reporter_n2"), { ...valid, reporterId: "someone-else" }));
  await assertFails(setDoc(doc(reporter, "reports/reporter_n2"), { ...valid, noteId: "n2", reason: "" }));
  await assertFails(setDoc(doc(reporter, "reports/reporter_n2"), { ...valid, noteId: "n2", extra: true }));
  await assertFails(getDoc(doc(reporter, "reports/reporter_n1")));
});
