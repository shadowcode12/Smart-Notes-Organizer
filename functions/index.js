// Email notification when a chat message is created.
// Deploy needs the Blaze plan. The email API key is stored as a secret, never in this repo:
//   firebase functions:secrets:set RESEND_API_KEY
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

admin.initializeApp();

const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const FROM_EMAIL = process.env.NOTIFY_FROM_EMAIL || 'SmartNotes <onboarding@resend.dev>';
const SITE_URL = process.env.SITE_URL || 'http://localhost:8080';

exports.notifyNewMessage = onDocumentCreated(
  {
    document: 'conversations/{conversationId}/messages/{messageId}',
    secrets: [RESEND_API_KEY]
  },
  async event => {
    const message = event.data?.data();
    if (!message) return;

    const { conversationId } = event.params;
    const conversation = await admin.firestore().doc(`conversations/${conversationId}`).get();
    const participants = conversation.data()?.participants || [];
    const recipientId = message.recipientId;

    // Only notify the other participant, never the sender or an outsider.
    if (!recipientId || recipientId === message.senderId || !participants.includes(recipientId)) return;

    const recipient = await admin.auth().getUser(recipientId).catch(() => null);
    if (!recipient?.email) return;

    // The email deliberately omits the message text and sender name. Readers open the site to see them.
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY.value()}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: [recipient.email],
        subject: 'You have a new message on SmartNotes',
        text: `You have a new message on SmartNotes.\n\nOpen your chats: ${SITE_URL}/pages/chats.html`
      })
    });

    if (!response.ok) {
      throw new Error(`Email provider returned HTTP ${response.status}`);
    }
  }
);
