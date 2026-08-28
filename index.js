const express = require("express");
const Imap = require("imap");
const { simpleParser } = require("mailparser");
const QRCode = require("qrcode");
const crypto = require("crypto");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const SECRET = process.env.ORDER_SECRET || "change-this-secret";

// -------------------- Helpers --------------------
function makeOrderId() {
  return "ORD" + Date.now().toString(36).toUpperCase() +
    crypto.randomBytes(3).toString("hex").toUpperCase();
}

function signOrder(data) {
  return crypto.createHmac("sha256", SECRET)
    .update(JSON.stringify(data))
    .digest("hex");
}

function verifyOrder(data, sig) {
  return crypto.timingSafeEqual(
    Buffer.from(signOrder(data)),
    Buffer.from(sig || "")
  );
}

function cleanNumber(v) {
  const n = Number(String(v).replace(/[₹,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// Basic parser for common Indian UPI/FAM-style notification emails.
// Adjust the keywords/regex if your exact FAM Pay email format differs.
function parseTransaction(text) {
  const t = String(text || "");

  const amountMatches = [
    /(?:₹|INR|Rs\.?)\s*([0-9,]+(?:\.[0-9]{1,2})?)/i,
    /(?:received|credited|paid|payment)[^₹\n]{0,80}(?:₹|INR|Rs\.?)\s*([0-9,]+(?:\.[0-9]{1,2})?)/i
  ];

  let amount = null;
  for (const re of amountMatches) {
    const m = t.match(re);
    if (m) {
      amount = cleanNumber(m[1]);
      if (amount !== null) break;
    }
  }

  const utr =
    (t.match(/(?:UTR|UPI\s*Ref(?:erence)?|RRN|Transaction\s*(?:ID|No\.?))\s*[:#-]?\s*([A-Za-z0-9._-]{6,40})/i) || [])[1] || null;

  const orderId =
    (t.match(/(?:Order\s*ID|OrderID|Merchant\s*Order)\s*[:#-]?\s*([A-Za-z0-9._-]{4,80})/i) || [])[1] || null;

  const type = /(?:received|credited|credit|successful\s*payment|payment\s*received)/i.test(t)
    ? "CREDIT"
    : /(?:debit|paid|sent|payment\s*made)/i.test(t)
      ? "DEBIT"
      : "UNKNOWN";

  return { amount, utr, orderId, type };
}

function openInbox({ user, password }) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user,
      password,
      host: "imap.gmail.com",
      port: 993,
      tls: true,
      tlsOptions: { rejectUnauthorized: true },
      connTimeout: 15000,
      authTimeout: 15000
    });

    imap.once("ready", () => resolve(imap));
    imap.once("error", reject);
    imap.connect();
  });
}

function searchRecentEmails(imap, sinceDate) {
  return new Promise((resolve, reject) => {
    imap.openBox("INBOX", true, (err) => {
      if (err) return reject(err);

      imap.search([["SINCE", sinceDate]], (err, results) => {
        if (err) return reject(err);
        resolve(results || []);
      });
    });
  });
}

function fetchMessages(imap, ids) {
  return new Promise((resolve, reject) => {
    if (!ids.length) return resolve([]);

    const out = [];
    const f = imap.fetch(ids, { bodies: "", markSeen: false });

    f.on("message", (msg) => {
      let raw = "";
      let attrs = null;

      msg.on("body", (stream) => {
        stream.on("data", chunk => raw += chunk.toString("utf8"));
      });

      msg.once("attributes", a => { attrs = a; });

      msg.once("end", async () => {
        try {
          const parsed = await simpleParser(raw);
          out.push({
            uid: attrs && attrs.uid,
            date: parsed.date || null,
            subject: parsed.subject || "",
            from: parsed.from?.text || "",
            text: parsed.text || "",
            html: parsed.html || ""
          });
        } catch (_) {}
      });
    });

    f.once("error", reject);
    f.once("end", () => setTimeout(() => resolve(out), 200));
  });
}

// -------------------- Health --------------------
app.get("/", (req, res) => {
  res.json({
    ok: true,
    name: "FAM Pay Transaction / OrderID Checker API",
    version: "1.0.0",
    endpoints: {
      createOrder: "POST /api/order/create",
      checkOrder: "POST /api/order/check",
      checkUTR: "GET /api/utr/check?gmail=...&appPass=...&utr=...",
      invoice: "POST /api/invoice"
    }
  });
});

// -------------------- Create Order + QR --------------------
app.post("/api/order/create", async (req, res) => {
  try {
    const amount = cleanNumber(req.body.amount);
    const upiId = String(req.body.upiId || "").trim();
    const name = String(req.body.name || "Payment").trim();
    const note = String(req.body.note || "").trim();

    if (!amount || amount <= 0) {
      return res.status(400).json({ ok: false, error: "Valid amount is required" });
    }
    if (!upiId || !upiId.includes("@")) {
      return res.status(400).json({ ok: false, error: "Valid UPI ID is required" });
    }

    const orderId = makeOrderId();

    // The order ID is deliberately placed in the UPI transaction note.
    // Verification requires the same order ID to appear in the received email.
    const transactionNote = orderId + (note ? " " + note : "");

    const upiUrl =
      `upi://pay?pa=${encodeURIComponent(upiId)}` +
      `&pn=${encodeURIComponent(name)}` +
      `&am=${encodeURIComponent(amount.toFixed(2))}` +
      `&cu=INR` +
      `&tn=${encodeURIComponent(transactionNote)}`;

    const qrDataUrl = await QRCode.toDataURL(upiUrl, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 500
    });

    const payload = { orderId, amount, upiId };
    const signature = signOrder(payload);

    res.json({
      ok: true,
      status: "PENDING",
      orderId,
      amount,
      upiId,
      note: transactionNote,
      qr: qrDataUrl,
      upiUrl,
      signature,
      expiresInMinutes: 30
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// -------------------- Check Order --------------------
app.post("/api/order/check", async (req, res) => {
  let imap;
  try {
    const gmail = String(req.body.gmail || "").trim();
    const appPass = String(req.body.appPass || "").trim();
    const orderId = String(req.body.orderId || "").trim();
    const amount = cleanNumber(req.body.amount);
    const signature = String(req.body.signature || "");

    if (!gmail || !appPass || !orderId || !amount) {
      return res.status(400).json({
        ok: false,
        status: "ERROR",
        error: "gmail, appPass, orderId and amount are required"
      });
    }

    if (!verifyOrder({ orderId, amount, upiId: String(req.body.upiId || "") }, signature)) {
      // Signature can only be verified when upiId is supplied.
      // For deployments using the returned signature, pass upiId too.
      return res.status(400).json({ ok: false, status: "ERROR", error: "Invalid order signature" });
    }

    imap = await openInbox({ user: gmail, password: appPass });
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const ids = await searchRecentEmails(imap, since);
    const messages = await fetchMessages(imap, ids.slice(-100));

    const matches = messages
      .map(m => ({ ...m, parsed: parseTransaction(m.text + "\n" + m.subject) }))
      .filter(m =>
        m.parsed.type === "CREDIT" &&
        Number(m.parsed.amount) === Number(amount) &&
        String(m.parsed.orderId || "").toLowerCase() === orderId.toLowerCase()
      );

    if (!matches.length) {
      return res.json({
        ok: true,
        status: "PENDING",
        verified: false,
        message: "Payment not fetched. Exact amount + Order ID match was not found."
      });
    }

    const tx = matches.sort((a, b) => new Date(b.date) - new Date(a.date))[0];

    return res.json({
      ok: true,
      status: "SUCCESS",
      verified: true,
      orderId,
      amount,
      utr: tx.parsed.utr,
      transactionType: tx.parsed.type,
      transactionDate: tx.date,
      subject: tx.subject,
      message: "Payment verified. Exact amount and Order ID matched."
    });
  } catch (e) {
    res.status(401).json({
      ok: false,
      status: "ERROR",
      error: "Gmail check failed. Verify Gmail address and App Password."
    });
  } finally {
    if (imap) {
      try { imap.end(); } catch (_) {}
    }
  }
});

// -------------------- UTR Checker --------------------
// GET /api/utr/check?gmail=...&appPass=...&utr=...
app.get("/api/utr/check", async (req, res) => {
  let imap;
  try {
    const gmail = String(req.query.gmail || "").trim();
    const appPass = String(req.query.appPass || "").trim();
    const utr = String(req.query.utr || "").trim();

    if (!gmail || !appPass || !utr) {
      return res.status(400).json({
        ok: false,
        status: "ERROR",
        error: "gmail, appPass and utr are required"
      });
    }

    imap = await openInbox({ user: gmail, password: appPass });
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const ids = await searchRecentEmails(imap, since);
    const messages = await fetchMessages(imap, ids.slice(-200));

    const hit = messages
      .map(m => ({ ...m, parsed: parseTransaction(m.text + "\n" + m.subject) }))
      .find(m =>
        String(m.parsed.utr || "").toLowerCase() === utr.toLowerCase()
      );

    if (!hit) {
      return res.json({
        ok: true,
        status: "NOT_FETCH",
        verified: false,
        utr,
        message: "UTR was not found in the authorized Gmail mailbox."
      });
    }

    res.json({
      ok: true,
      status: "SUCCESS",
      verified: true,
      utr,
      amount: hit.parsed.amount,
      transactionType: hit.parsed.type,
      transactionDate: hit.date,
      orderId: hit.parsed.orderId
    });
  } catch (e) {
    res.status(401).json({
      ok: false,
      status: "ERROR",
      error: "Gmail check failed. Verify Gmail address and App Password."
    });
  } finally {
    if (imap) {
      try { imap.end(); } catch (_) {}
    }
  }
});

// -------------------- Simple Invoice --------------------
app.post("/api/invoice", (req, res) => {
  const {
    orderId, amount, utr, customerName = "Customer",
    merchantName = "Merchant", date = new Date().toISOString()
  } = req.body;

  if (!orderId || !amount || !utr) {
    return res.status(400).json({
      ok: false,
      error: "orderId, amount and utr are required"
    });
  }

  res.json({
    ok: true,
    invoice: {
      invoiceId: "INV-" + orderId,
      orderId,
      customerName,
      merchantName,
      amount: Number(amount),
      utr,
      status: "PAID",
      date
    }
  });
});

app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});

module.exports = app;
