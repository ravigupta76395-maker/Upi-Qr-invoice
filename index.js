require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const QRCode = require('qrcode');
const { nanoid } = require('nanoid');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());
app.use(express.json());

// ---------------------------------------------------------------------
// MongoDB — Order model
// ---------------------------------------------------------------------
const OrderSchema = new mongoose.Schema({
  orderId: { type: String, required: true, unique: true, index: true },
  amount: { type: Number, required: true },
  upiId: { type: String, required: true },
  payeeName: { type: String, default: 'Merchant' },
  note: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'paid', 'expired'], default: 'pending' },
  matchedEmail: {
    subject: String,
    from: String,
    receivedAt: Date,
  },
  createdAt: { type: Date, default: Date.now },
  paidAt: { type: Date },
});
const Order = mongoose.models.Order || mongoose.model('Order', OrderSchema);

// ---------------------------------------------------------------------
// Settings — lets you set Gmail App Password / UPI ID from index.html
// instead of the Vercel dashboard. Sent as a POST body, never a URL
// query param, since query params end up in logs and browser history.
// ---------------------------------------------------------------------
const ConfigSchema = new mongoose.Schema({
  gmailUser: String,
  gmailAppPassword: String,
  upiId: String,
  upiPayeeName: String,
  updatedAt: { type: Date, default: Date.now },
});
const Config = mongoose.models.Config || mongoose.model('Config', ConfigSchema);

async function getConfig() {
  const saved = await Config.findOne().sort({ updatedAt: -1 });
  return {
    gmailUser: saved?.gmailUser || process.env.GMAIL_USER,
    gmailAppPassword: saved?.gmailAppPassword || process.env.GMAIL_APP_PASSWORD,
    upiId: saved?.upiId || process.env.UPI_ID,
    upiPayeeName: saved?.upiPayeeName || process.env.UPI_PAYEE_NAME || 'Merchant',
  };
}

let isConnected = false;
async function connectDB() {
  if (isConnected) return;
  await mongoose.connect(process.env.MONGODB_URI);
  isConnected = true;
}

app.use(async (req, res, next) => {
  try {
    await connectDB();
    next();
  } catch (err) {
    console.error('DB connection error:', err);
    res.status(500).json({ error: 'Database connection failed' });
  }
});

// ---------------------------------------------------------------------
// FamPay Gmail alert check (IMAP + App Password)
//
// NOTE: FamPay's exact email subject/body wording isn't something we've
// verified against a real sample. AMOUNT_REGEXES below covers common
// Indian payment-alert phrasing (₹ / Rs / INR + "received"/"credited").
// If real emails aren't matching, forward one to yourself, check its
// exact text, and tighten SENDER_MATCH / AMOUNT_REGEXES below.
// ---------------------------------------------------------------------
const SENDER_MATCH = (process.env.FAMPAY_SENDER || 'fampay.in,famapp.in')
  .split(',')
  .map(s => s.trim().toLowerCase());

const AMOUNT_REGEXES = [
  /(?:received|credited|credit of|added)[^₹Rs\d]{0,20}(?:₹|Rs\.?|INR)\s?([\d,]+(?:\.\d{1,2})?)/i,
  /(?:₹|Rs\.?|INR)\s?([\d,]+(?:\.\d{1,2})?)[^.]{0,20}(?:received|credited)/i,
];

function extractAmount(text) {
  for (const re of AMOUNT_REGEXES) {
    const m = text.match(re);
    if (m) return parseFloat(m[1].replace(/,/g, ''));
  }
  return null;
}

function amountsMatch(a, b, tolerance = 0.01) {
  return Math.abs(a - b) <= tolerance;
}

async function checkGmailForPayment(order, config) {
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: config.gmailUser,
      pass: config.gmailAppPassword, // 16-char Gmail App Password, not your normal password
    },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(order.createdAt);
      since.setMinutes(since.getMinutes() - 2); // buffer for clock drift

      const uids = await client.search({ since }, { uid: true });
      if (!uids || uids.length === 0) return { found: false };

      for (const uid of uids.reverse()) {
        const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
        if (!msg) continue;

        const fromAddr = (msg.envelope?.from?.[0]?.address || '').toLowerCase();
        const isFromFamPay = SENDER_MATCH.some(domain => fromAddr.includes(domain));
        if (!isFromFamPay) continue;

        const parsed = await simpleParser(msg.source);
        const bodyText = (parsed.text || parsed.html || '') + ' ' + (parsed.subject || '');
        const amount = extractAmount(bodyText);

        if (amount !== null && amountsMatch(amount, order.amount)) {
          return {
            found: true,
            email: {
              subject: parsed.subject || '',
              from: fromAddr,
              receivedAt: parsed.date || new Date(),
            },
          };
        }
      }
      return { found: false };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

// ---------------------------------------------------------------------
// Core logic (shared by both the HTTP API and the Telegram bot)
// ---------------------------------------------------------------------
async function createOrder({ amount, note }) {
  if (!amount || isNaN(amount) || Number(amount) <= 0) {
    throw new Error('Valid amount is required');
  }
  const config = await getConfig();
  if (!config.upiId) {
    throw new Error('UPI ID not configured yet — set it in Settings first');
  }

  const orderId = nanoid(10);

  const params = new URLSearchParams({
    pa: config.upiId,
    pn: config.upiPayeeName,
    am: Number(amount).toFixed(2),
    cu: 'INR',
    tn: (note || `Order ${orderId}`).slice(0, 50),
  });
  const upiLink = `upi://pay?${params.toString()}`;
  const qrDataUrl = await QRCode.toDataURL(upiLink, { margin: 1, width: 300 });
  const qrBuffer = await QRCode.toBuffer(upiLink, { margin: 1, width: 400 });

  const order = await Order.create({
    orderId,
    amount: Number(amount),
    upiId: config.upiId,
    payeeName: config.upiPayeeName,
    note: note || '',
  });

  return { order, upiLink, qrDataUrl, qrBuffer };
}

async function checkPaymentStatus(orderId) {
  const order = await Order.findOne({ orderId });
  if (!order) throw Object.assign(new Error('Order not found'), { code: 404 });

  if (order.status === 'paid') return order;

  const config = await getConfig();
  if (!config.gmailUser || !config.gmailAppPassword) {
    throw new Error('Gmail App Password not configured yet — set it in Settings first');
  }

  const result = await checkGmailForPayment(order, config);
  if (result.found) {
    order.status = 'paid';
    order.paidAt = new Date();
    order.matchedEmail = result.email;
    await order.save();
  }
  return order;
}

// ---------------------------------------------------------------------
// Telegram bot — webhook mode (no polling, works on serverless)
// ---------------------------------------------------------------------
let bot = null;
if (process.env.TELEGRAM_BOT_TOKEN) {
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { webHook: { autoOpen: false } });

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    if (text === '/start') {
      return bot.sendMessage(chatId, 'Amount bhejo (e.g. 500) — main UPI QR bana dunga. Pay karne ke baad "Check Payment" button dabao.');
    }

    const amount = Number(text.replace(/[^\d.]/g, ''));
    if (!amount || amount <= 0) {
      return bot.sendMessage(chatId, 'Sirf amount bhejo, jaise: 500');
    }

    try {
      const { order, qrBuffer } = await createOrder({ amount, note: `Order via Telegram` });
      await bot.sendPhoto(chatId, qrBuffer, {
        caption: `Order ID: ${order.orderId}\nAmount: ₹${order.amount.toFixed(2)}\n\nQR scan karke pay karo, phir neeche button dabao.`,
        reply_markup: {
          inline_keyboard: [[{ text: '✅ Check Payment', callback_data: `check:${order.orderId}` }]],
        },
      });
    } catch (err) {
      console.error('bot create-order error:', err);
      bot.sendMessage(chatId, 'Order create nahi ho paaya: ' + err.message);
    }
  });

  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data || '';
    if (!data.startsWith('check:')) return;
    const orderId = data.slice('check:'.length);

    await bot.answerCallbackQuery(query.id, { text: 'Checking...' });

    try {
      const order = await checkPaymentStatus(orderId);
      if (order.status === 'paid') {
        await bot.sendMessage(chatId, `✅ Order ${order.orderId} — Payment received (₹${order.amount.toFixed(2)})`);
      } else {
        await bot.sendMessage(chatId, `⏳ Order ${order.orderId} — Payment abhi tak nahi mila. Thodi der baad dobara check karo.`);
      }
    } catch (err) {
      console.error('bot check-payment error:', err);
      bot.sendMessage(chatId, 'Check karne mein error: ' + err.message);
    }
  });
}

// ---------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'upi-order-api' });
});

// Telegram webhook endpoint — set with:
// https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://yourdomain.vercel.app/bot/webhook
app.post('/bot/webhook', (req, res) => {
  if (!bot) return res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not configured' });
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// Save settings (Gmail App Password / UPI ID) — sent in POST body, never in a URL
app.post('/config', async (req, res) => {
  try {
    const existing = await getConfig();
    const { gmailUser, gmailAppPassword, upiId, upiPayeeName } = req.body;
    await Config.create({
      gmailUser: gmailUser !== undefined && gmailUser !== '' ? gmailUser : existing.gmailUser,
      gmailAppPassword: gmailAppPassword ? gmailAppPassword : existing.gmailAppPassword,
      upiId: upiId !== undefined && upiId !== '' ? upiId : existing.upiId,
      upiPayeeName: upiPayeeName !== undefined && upiPayeeName !== '' ? upiPayeeName : existing.upiPayeeName,
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('config save error:', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// Check current settings status (never returns the actual password)
app.get('/config', async (req, res) => {
  try {
    const config = await getConfig();
    res.json({
      gmailUser: config.gmailUser || null,
      gmailAppPasswordSet: !!config.gmailAppPassword,
      upiId: config.upiId || null,
      upiPayeeName: config.upiPayeeName || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

// Create order + generate UPI QR
app.post('/create-order', async (req, res) => {
  try {
    const { amount, note, customerName } = req.body;
    const { order, upiLink, qrDataUrl } = await createOrder({ amount, note });
    res.json({
      orderId: order.orderId,
      amount: order.amount,
      status: order.status,
      upiLink,
      qrDataUrl,
      customerName: customerName || null,
    });
  } catch (err) {
    console.error('create-order error:', err);
    res.status(400).json({ error: err.message || 'Failed to create order' });
  }
});

// Check whether payment for an order has been received
app.get('/check-payment/:orderId', async (req, res) => {
  try {
    const order = await checkPaymentStatus(req.params.orderId);
    res.json({
      orderId: order.orderId,
      status: order.status,
      paidAt: order.paidAt || null,
      matchedEmail: order.matchedEmail || null,
    });
  } catch (err) {
    console.error('check-payment error:', err);
    const code = err.code === 404 ? 404 : 500;
    res.status(code).json({ error: err.message || 'Failed to check payment status' });
  }
});

// List recent orders
app.get('/orders', async (req, res) => {
  try {
    const orders = await Order.find().sort({ createdAt: -1 }).limit(50);
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

// Local dev entrypoint
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
}

module.exports = app;
