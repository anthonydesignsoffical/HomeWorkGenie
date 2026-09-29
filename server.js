'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const nodemailer = require('nodemailer');
let Pool = null;
if (process.env.DATABASE_URL) {
  ({ Pool } = require('pg'));
}

/*
|--------------------------------------------------------------------------
| LOAD .ENV
|--------------------------------------------------------------------------
| This project intentionally uses a tiny built-in .env loader so that
| dotenv is not required.
|--------------------------------------------------------------------------
*/

(function loadDotEnv() {
  try {
    const envFile = path.join(__dirname, '.env');
    const text = fs.readFileSync(envFile, 'utf8');

    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();

      if (!line || line.startsWith('#')) continue;

      const i = line.indexOf('=');
      if (i < 1) continue;

      const key = line.slice(0, i).trim();

      let value = line.slice(i + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional during development.
  }
})();

/*
|--------------------------------------------------------------------------
| CONFIGURATION
|--------------------------------------------------------------------------
*/

const ROOT = __dirname;

const PUBLIC_DIR = path.join(ROOT, 'public');

const DATA_DIR = process.env.HG_DATA_DIR
  ? path.resolve(process.env.HG_DATA_DIR)
  : path.join(ROOT, 'data');

const FILE_DIR = path.join(DATA_DIR, 'files');

const DB_FILE = path.join(DATA_DIR, 'db.json');

const PORT = Number(process.env.PORT || 3000);

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  (process.env.NODE_ENV === 'production'
    ? ''
    : crypto.randomBytes(48).toString('hex'));

const ADMIN_EMAIL =
  String(
    process.env.ADMIN_EMAIL || 'hwgenie@proton.me'
  )
    .trim()
    .toLowerCase();

const ADMIN_INITIAL_PASSWORD =
  process.env.ADMIN_INITIAL_PASSWORD ||
  '';

const COOKIE_NAME = 'hg_session';

const APP_BASE_URL =
  String(
    process.env.APP_BASE_URL || `http://localhost:${PORT}`
  ).replace(/\/+$/, '');

/*
|--------------------------------------------------------------------------
| EMAIL / SMTP CONFIGURATION
|--------------------------------------------------------------------------
*/

const SMTP_ENABLED =
  Boolean(process.env.SMTP_HOST) &&
  Boolean(process.env.SMTP_USER) &&
  Boolean(process.env.SMTP_PASSWORD);

const emailTransporter = SMTP_ENABLED
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 465),

      secure:
        String(process.env.SMTP_SECURE || 'true').toLowerCase() ===
        'true',

      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD
      }
    })
  : null;

const EMAIL_FROM =
  process.env.EMAIL_FROM ||
  `Homework Genie <${process.env.SMTP_USER || 'admin@homeworkgenie.online'}>`;

const ADMIN_NOTIFICATION_EMAIL =
  process.env.ADMIN_NOTIFICATION_EMAIL ||
  process.env.ADMIN_EMAIL ||
  'admin@homeworkgenie.online';

/*
|--------------------------------------------------------------------------
| LIMITS / SECURITY
|--------------------------------------------------------------------------
*/

const MAX_BODY = 35 * 1024 * 1024;

const MAX_FILE = 20 * 1024 * 1024;

const SESSION_DAYS = 7;

const PBKDF2_ITERATIONS = 210000;

const ALLOWED_EXT = new Set([
  'pdf',
  'doc',
  'docx',
  'ppt',
  'pptx',
  'xls',
  'xlsx',
  'txt',
  'zip'
]);

const STATUS_VALUES = new Set([
  'request_received',
  'under_review',
  'quote_sent',
  'payment_pending',
  'in_progress',
  'quality_check',
  'completed',
  'cancelled'
]);

if (!process.env.SESSION_SECRET) {
  console.warn(
    'SESSION_SECRET not set; a random development secret was generated for this process. Set it in .env before production.'
  );
}

fs.mkdirSync(FILE_DIR, { recursive: true });

/*
|--------------------------------------------------------------------------
| DATABASE
|--------------------------------------------------------------------------
*/

const EMPTY_DB = () => ({
  version: 3,
  users: [],
  requests: [],
  assignments: [],
  quotes: [],
  invoices: [],
  payments: [],
  notifications: [],
  resetTokens: [],
  sessions: []
});

let writeChain = Promise.resolve();
const USE_POSTGRES = Boolean(process.env.DATABASE_URL);
const pgPool = USE_POSTGRES
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: String(process.env.DATABASE_SSL || 'true').toLowerCase() === 'true'
        ? { rejectUnauthorized: false }
        : false
    })
  : null;

function readDbSync() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return EMPTY_DB();
  }
}

function ensureDbShape(d) {
  const e = EMPTY_DB();

  for (const k of Object.keys(e)) {
    if (!Array.isArray(e[k]) && typeof e[k] !== 'number') {
      d[k] = e[k];
    }
  }

  if (!d.version) d.version = 3;
  if (!Array.isArray(d.resetTokens)) d.resetTokens = [];
  if (!Array.isArray(d.sessions)) d.sessions = [];

  return d;
}

let DB = ensureDbShape(readDbSync());

function db() {
  return DB;
}

async function initPostgres() {
  if (!pgPool) return;

  await pgPool.query(`
    CREATE TABLE IF NOT EXISTS application_state (
      id SMALLINT PRIMARY KEY,
      state JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const result = await pgPool.query(
    'SELECT state FROM application_state WHERE id = 1'
  );

  if (result.rows.length) {
    DB = ensureDbShape(result.rows[0].state);
  } else {
    await pgPool.query(
      `INSERT INTO application_state (id, state) VALUES (1, $1::jsonb)`,
      [JSON.stringify(DB)]
    );
  }

  console.log('✓ PostgreSQL database connected');
}

function atomicSave(next) {
  DB = ensureDbShape(next);

  if (!pgPool) {
    const data = JSON.stringify(DB, null, 2);
    const tmp = DB_FILE + '.tmp';

    writeChain = writeChain.then(async () => {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      await fsp.writeFile(tmp, data, 'utf8');
      await fsp.rename(tmp, DB_FILE);
    });

    return writeChain;
  }

  const state = JSON.stringify(DB);

  writeChain = writeChain.then(async () => {
    await pgPool.query(
      `UPDATE application_state
       SET state = $1::jsonb, updated_at = NOW()
       WHERE id = 1`,
      [state]
    );
  });

  return writeChain;
}

/*
|--------------------------------------------------------------------------
| GENERAL HELPERS
|--------------------------------------------------------------------------
*/

function id() {
  return crypto.randomUUID();
}

function now() {
  return new Date().toISOString();
}

/*
|--------------------------------------------------------------------------
| EMAIL HELPERS
|--------------------------------------------------------------------------
*/

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function sendEmail({
  to,
  subject,
  html,
  text
}) {
  if (!emailTransporter) {
    console.warn(
      `Email not sent to ${to}: SMTP is not configured.`
    );

    return {
      sent: false,
      skipped: true,
      reason: 'SMTP not configured'
    };
  }

  try {
    const info = await emailTransporter.sendMail({
      from: EMAIL_FROM,
      to,
      subject,
      text,
      html
    });

    console.log(
      `Email sent to ${to}: ${info.messageId}`
    );

    return {
      sent: true,
      messageId: info.messageId
    };
  } catch (error) {
    console.error(
      `Email failed for ${to}:`,
      error.message
    );

    return {
      sent: false,
      error: error.message
    };
  }
}

async function sendNewRequestEmail(request) {
  return sendEmail({
    to: ADMIN_NOTIFICATION_EMAIL,

    subject:
      `New Quote Request — ${request.id}`,

    text: `
A new quote request has been submitted.

Request ID: ${request.id}
Name: ${request.name}
Email: ${request.email}
Phone: ${request.phone}
Service: ${request.service}
Subject: ${request.subject}
Assignment: ${request.title}
Deadline: ${request.deadline}

Log in to the Homework Genie Admin Dashboard to review the request.
`.trim(),

    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;max-width:700px;margin:auto">
        <h2>New Quote Request</h2>

        <p>A new quote request has been submitted to Homework Genie.</p>

        <table cellpadding="8" cellspacing="0" border="0">
          <tr>
            <td><strong>Request ID</strong></td>
            <td>${escapeHtml(request.id)}</td>
          </tr>

          <tr>
            <td><strong>Name</strong></td>
            <td>${escapeHtml(request.name)}</td>
          </tr>

          <tr>
            <td><strong>Email</strong></td>
            <td>${escapeHtml(request.email)}</td>
          </tr>

          <tr>
            <td><strong>Phone</strong></td>
            <td>${escapeHtml(request.phone)}</td>
          </tr>

          <tr>
            <td><strong>Service</strong></td>
            <td>${escapeHtml(request.service)}</td>
          </tr>

          <tr>
            <td><strong>Subject</strong></td>
            <td>${escapeHtml(request.subject)}</td>
          </tr>

          <tr>
            <td><strong>Assignment</strong></td>
            <td>${escapeHtml(request.title)}</td>
          </tr>

          <tr>
            <td><strong>Deadline</strong></td>
            <td>${escapeHtml(request.deadline)}</td>
          </tr>
        </table>

        <p>
          <a
            href="${escapeHtml(APP_BASE_URL)}/admin.html"
            style="
              display:inline-block;
              padding:12px 20px;
              background:#111827;
              color:white;
              text-decoration:none;
              border-radius:6px;
            "
          >
            Open Admin Dashboard
          </a>
        </p>
      </div>
    `
  });
}

async function sendQuoteEmail(quote, quoteUrl) {
  return sendEmail({
    to: quote.student.email,

    subject:
      `Your Homework Genie Quote — ${quote.quoteNumber}`,

    text: `
Hello ${quote.student.name},

We've reviewed your Homework Genie request and prepared your quotation.

Quote: ${quote.quoteNumber}
Service: ${quote.service}
Assignment: ${quote.title}
Deadline: ${quote.deadline}

Base price: ${quote.basePrice}
Additional charges: ${quote.additionalCharges}
Total: ${quote.price}

Quote valid until: ${quote.expiryDate || 'Not specified'}

View your quotation:
${quoteUrl}

Thank you,
Homework Genie
`.trim(),

    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;max-width:700px;margin:auto">

        <h2>Your Homework Genie Quote Is Ready</h2>

        <p>
          Hello ${escapeHtml(quote.student.name)},
        </p>

        <p>
          We've reviewed your request and prepared your quotation.
        </p>

        <table cellpadding="8" cellspacing="0" border="0">
          <tr>
            <td><strong>Quote</strong></td>
            <td>${escapeHtml(quote.quoteNumber)}</td>
          </tr>

          <tr>
            <td><strong>Service</strong></td>
            <td>${escapeHtml(quote.service)}</td>
          </tr>

          <tr>
            <td><strong>Assignment</strong></td>
            <td>${escapeHtml(quote.title)}</td>
          </tr>

          <tr>
            <td><strong>Deadline</strong></td>
            <td>${escapeHtml(quote.deadline)}</td>
          </tr>

          <tr>
            <td><strong>Base Price</strong></td>
            <td>${escapeHtml(quote.basePrice)}</td>
          </tr>

          <tr>
            <td><strong>Additional Charges</strong></td>
            <td>${escapeHtml(quote.additionalCharges)}</td>
          </tr>

          <tr>
            <td><strong>Total</strong></td>
            <td><strong>${escapeHtml(quote.price)}</strong></td>
          </tr>

          <tr>
            <td><strong>Valid Until</strong></td>
            <td>${escapeHtml(quote.expiryDate || 'Not specified')}</td>
          </tr>
        </table>

        <p>
          <a
            href="${escapeHtml(quoteUrl)}"
            style="
              display:inline-block;
              padding:14px 24px;
              background:#111827;
              color:white;
              text-decoration:none;
              border-radius:6px;
              font-weight:bold;
            "
          >
            View Your Quote
          </a>
        </p>

        ${
          quote.terms
            ? `
              <h3>Terms</h3>
              <p>${escapeHtml(quote.terms)}</p>
            `
            : ''
        }

        <p>
          Thank you,<br>
          <strong>Homework Genie</strong>
        </p>

      </div>
    `
  });
}

async function sendQuoteAcceptedEmail(quote, invoice) {
  return sendEmail({
    to: quote.student.email,

    subject:
      `Quote Accepted — Invoice ${invoice.invoiceNumber}`,

    text: `
Your Homework Genie quote ${quote.quoteNumber} has been accepted.

Invoice: ${invoice.invoiceNumber}
Amount: ${invoice.amount}
Status: Payment Pending

Please follow the payment instructions provided by Homework Genie.
`.trim(),

    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6">
        <h2>Quote Accepted</h2>

        <p>
          Your quote
          <strong>${escapeHtml(quote.quoteNumber)}</strong>
          has been accepted.
        </p>

        <p>
          Invoice:
          <strong>${escapeHtml(invoice.invoiceNumber)}</strong>
        </p>

        <p>
          Amount:
          <strong>${escapeHtml(invoice.amount)}</strong>
        </p>

        <p>
          Your invoice is now awaiting payment.
        </p>

        <p>
          Thank you,<br>
          <strong>Homework Genie</strong>
        </p>
      </div>
    `
  });
}

async function sendPaymentReceivedEmail(invoice, payment) {
  return sendEmail({
    to: invoice.email,

    subject:
      `Payment Received — ${invoice.invoiceNumber}`,

    text: `
Homework Genie has recorded your payment.

Invoice: ${invoice.invoiceNumber}
Amount: ${payment.amount}
Payment method: ${payment.method}
Reference: ${payment.reference || 'Not provided'}

Thank you,
Homework Genie
`.trim(),

    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6">
        <h2>Payment Received</h2>

        <p>
          Homework Genie has recorded your payment.
        </p>

        <p>
          <strong>Invoice:</strong>
          ${escapeHtml(invoice.invoiceNumber)}
        </p>

        <p>
          <strong>Amount:</strong>
          ${escapeHtml(payment.amount)}
        </p>

        <p>
          <strong>Payment method:</strong>
          ${escapeHtml(payment.method)}
        </p>

        ${
          payment.reference
            ? `
              <p>
                <strong>Reference:</strong>
                ${escapeHtml(payment.reference)}
              </p>
            `
            : ''
        }

        <p>
          Thank you,<br>
          <strong>Homework Genie</strong>
        </p>
      </div>
    `
  });
}

/*
|--------------------------------------------------------------------------
| AUTHENTICATION
|--------------------------------------------------------------------------
*/

function timingSafeEqualText(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));

  return (
    aa.length === bb.length &&
    crypto.timingSafeEqual(aa, bb)
  );
}

function hashPassword(
  password,
  salt = crypto.randomBytes(16).toString('hex')
) {
  const hash = crypto
    .pbkdf2Sync(
      String(password),
      salt,
      PBKDF2_ITERATIONS,
      32,
      'sha256'
    )
    .toString('hex');

  return {
    salt,
    hash,
    iterations: PBKDF2_ITERATIONS,
    algorithm: 'sha256'
  };
}

function verifyPassword(password, u) {
  if (
    !u ||
    !u.passwordHash ||
    !u.passwordSalt
  ) {
    return false;
  }

  const hash = crypto
    .pbkdf2Sync(
      String(password),
      u.passwordSalt,
      Number(
        u.passwordIterations ||
          PBKDF2_ITERATIONS
      ),
      32,
      'sha256'
    )
    .toString('hex');

  return timingSafeEqualText(
    hash,
    u.passwordHash
  );
}

function token(payload) {
  const body = Buffer
    .from(
      JSON.stringify({
        ...payload,
        exp:
          Date.now() +
          SESSION_DAYS * 86400000,
        iat: Date.now()
      })
    )
    .toString('base64url');

  const sig = crypto
    .createHmac(
      'sha256',
      SESSION_SECRET
    )
    .update(body)
    .digest('base64url');

  return `${body}.${sig}`;
}

function verifyToken(t) {
  try {
    const [
      body,
      sig
    ] = String(t || '').split('.');

    if (!body || !sig) {
      return null;
    }

    const good = crypto
      .createHmac(
        'sha256',
        SESSION_SECRET
      )
      .update(body)
      .digest('base64url');

    if (
      !timingSafeEqualText(
        sig,
        good
      )
    ) {
      return null;
    }

    const p = JSON.parse(
      Buffer
        .from(body, 'base64url')
        .toString('utf8')
    );

    if (
      !p.exp ||
      p.exp < Date.now()
    ) {
      return null;
    }

    return p;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};

  for (
    const part of String(
      req.headers.cookie || ''
    ).split(';')
  ) {
    const i = part.indexOf('=');

    if (i < 0) continue;

    out[
      part
        .slice(0, i)
        .trim()
    ] = decodeURIComponent(
      part
        .slice(i + 1)
        .trim()
    );
  }

  return out;
}

function auth(req) {
  const cookie =
    parseCookies(req)[
      COOKIE_NAME
    ];

  const authorization =
    String(
      req.headers.authorization || ''
    );

  const bearer =
    authorization.startsWith(
      'Bearer '
    )
      ? authorization.slice(7)
      : '';

  return verifyToken(
    cookie || bearer
  );
}

function publicUser(u) {
  if (!u) return null;

  const {
    passwordHash,
    passwordSalt,
    passwordIterations,
    ...safe
  } = u;

  return safe;
}

/*
|--------------------------------------------------------------------------
| HTTP RESPONSE HELPERS
|--------------------------------------------------------------------------
*/

function securityHeaders() {
  const headers = {
    'Content-Security-Policy':
      "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self'; worker-src 'self' blob:",

    'X-Content-Type-Options':
      'nosniff',

    'X-Frame-Options':
      'DENY',

    'Referrer-Policy':
      'strict-origin-when-cross-origin',

    'Permissions-Policy':
      'camera=(), microphone=(), geolocation=()',

    'Cache-Control':
      'no-store'
  };

  if (process.env.NODE_ENV === 'production') {
    headers['Strict-Transport-Security'] =
      'max-age=31536000; includeSubDomains';
  }

  return headers;
}

function sendJson(
  res,
  status,
  obj,
  extra = {}
) {
  const body = Buffer.from(
    JSON.stringify(obj)
  );

  res.writeHead(
    status,
    {
      'Content-Type':
        'application/json; charset=utf-8',

      'Content-Length':
        body.length,

      ...securityHeaders(),

      ...extra
    }
  );

  res.end(body);
}

function sendNoContent(res) {
  res.writeHead(
    204,
    securityHeaders()
  );

  res.end();
}

function setSession(
  res,
  payload
) {
  const t = token(payload);

  const secure =
    process.env.NODE_ENV ===
    'production'
      ? '; Secure'
      : '';

  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(
      t
    )}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${
      SESSION_DAYS * 86400
    }${secure}`
  );
}

function clearSession(res) {
  const secure =
    process.env.NODE_ENV ===
    'production'
      ? '; Secure'
      : '';

  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`
  );
}

/*
|--------------------------------------------------------------------------
| RATE LIMITING
|--------------------------------------------------------------------------
*/

function clientIp(req) {
  return String(
    req.headers['x-forwarded-for'] ||
      req.socket.remoteAddress ||
      'unknown'
  )
    .split(',')[0]
    .trim();
}

const rate = new Map();

function rateLimit(
  req,
  key,
  limit,
  windowMs
) {
  const k =
    `${key}:${clientIp(req)}`;

  const t = Date.now();

  const x =
    rate.get(k) || {
      count: 0,
      reset:
        t + windowMs
    };

  if (t > x.reset) {
    x.count = 0;
    x.reset =
      t + windowMs;
  }

  x.count++;

  rate.set(k, x);

  return x.count <= limit;
}

/*
|--------------------------------------------------------------------------
| REQUEST HELPERS
|--------------------------------------------------------------------------
*/

function requireAuth(
  req,
  role
) {
  const a = auth(req);

  if (!a) {
    return {
      error: 'Unauthorized',
      status: 401
    };
  }

  if (
    role &&
    a.role !== role
  ) {
    return {
      error: 'Forbidden',
      status: 403
    };
  }

  return {
    auth: a
  };
}

function jsonBody(req) {
  return new Promise(
    (resolve, reject) => {
      let s = '';

      let n = 0;

      let done = false;

      req.on(
        'data',
        c => {
          if (done) return;

          n += c.length;

          if (n > MAX_BODY) {
            done = true;

            reject(
              new Error(
                'Request is too large.'
              )
            );

            req.destroy();

            return;
          }

          s += c.toString(
            'utf8'
          );
        }
      );

      req.on(
        'end',
        () => {
          if (done) return;

          try {
            resolve(
              s
                ? JSON.parse(s)
                : {}
            );
          } catch {
            reject(
              new Error(
                'Invalid JSON body.'
              )
            );
          }
        }
      );

      req.on(
        'error',
        reject
      );
    }
  );
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(
    email
  );
}

function validPassword(p) {
  return (
    typeof p === 'string' &&
    p.length >= 10 &&
    /[A-Za-z]/.test(p) &&
    /\d/.test(p)
  );
}

/*
|--------------------------------------------------------------------------
| FILE HANDLING
|--------------------------------------------------------------------------
*/

function ext(name) {
  return path
    .extname(
      String(name || '')
    )
    .slice(1)
    .toLowerCase();
}

function safeOriginalName(name) {
  return path
    .basename(
      String(name || 'file')
    )
    .replace(
      /[\r\n"\\]/g,
      '_'
    )
    .slice(0, 180);
}

function storeFiles(
  items,
  ownerId,
  parentId
) {
  if (!Array.isArray(items)) {
    throw new Error(
      'Files must be an array.'
    );
  }

  if (items.length > 10) {
    throw new Error(
      'You can upload up to 10 files.'
    );
  }

  const out = [];

  for (const f of items) {
    const e = ext(f.name);

    if (!ALLOWED_EXT.has(e)) {
      throw new Error(
        `File type not allowed: ${
          e || 'unknown'
        }`
      );
    }

    if (
      !f.data ||
      typeof f.data !== 'string'
    ) {
      throw new Error(
        `Missing file data: ${f.name}`
      );
    }

    const buf = Buffer.from(
      f.data,
      'base64'
    );

    if (
      !buf.length ||
      buf.length > MAX_FILE
    ) {
      throw new Error(
        `File exceeds 20 MB: ${f.name}`
      );
    }

    const fid = id();

    const filename =
      `${fid}.${e}`;

    fs.writeFileSync(
      path.join(
        FILE_DIR,
        filename
      ),
      buf,
      {
        flag: 'wx'
      }
    );

    out.push({
      id: fid,
      name: safeOriginalName(
        f.name
      ),
      size: buf.length,
      type: String(
        f.type ||
          'application/octet-stream'
      ).slice(0, 120),
      filename,
      ownerId,
      parentId,
      createdAt: now()
    });
  }

  return out;
}

function publicFiles(files) {
  return (
    files || []
  ).map(
    ({
      filename,
      ...f
    }) => f
  );
}

/*
|--------------------------------------------------------------------------
| NOTIFICATIONS / TOKENS
|--------------------------------------------------------------------------
*/

function notify(
  d,
  type,
  data
) {
  d.notifications.unshift({
    id: id(),
    type,
    data,
    createdAt: now(),
    read: false
  });
}

function issueResetToken(
  d,
  userId
) {
  const raw =
    crypto
      .randomBytes(32)
      .toString('hex');

  const hash =
    crypto
      .createHash('sha256')
      .update(raw)
      .digest('hex');

  d.resetTokens =
    Array.isArray(
      d.resetTokens
    )
      ? d.resetTokens
      : [];

  d.resetTokens.push({
    id: id(),
    userId,
    tokenHash: hash,
    expiresAt:
      Date.now() +
      30 * 60 * 1000,
    createdAt: now(),
    usedAt: null
  });

  return raw;
}

function consumeResetToken(
  d,
  raw
) {
  const hash =
    crypto
      .createHash('sha256')
      .update(
        String(raw || '')
      )
      .digest('hex');

  const item =
    (
      d.resetTokens || []
    ).find(
      x =>
        x.tokenHash ===
          hash &&
        !x.usedAt &&
        x.expiresAt >
          Date.now()
    );

  if (!item) {
    return null;
  }

  item.usedAt = now();

  return item;
}

function issueGuestToken() {
  return crypto
    .randomBytes(32)
    .toString('hex');
}

function hashOpaqueToken(raw) {
  return crypto
    .createHash('sha256')
    .update(
      String(raw || '')
    )
    .digest('hex');
}

function nextNumber(
  prefix,
  arr
) {
  return (
    `${prefix}-${new Date().getFullYear()}-` +
    `${String(arr.length + 1).padStart(5, '0')}`
  );
}

/*
|--------------------------------------------------------------------------
| DATA LOOKUPS
|--------------------------------------------------------------------------
*/

function findRequest(
  d,
  requestId
) {
  return (
    d.requests.find(
      r =>
        r.id === requestId
    ) ||
    d.assignments.find(
      r =>
        r.id === requestId
    )
  );
}

function findAllFiles(d) {
  return [
    ...d.requests.flatMap(
      r => r.files || []
    ),

    ...d.assignments.flatMap(
      a => a.files || []
    )
  ];
}

/*
|--------------------------------------------------------------------------
| CSRF / ORIGIN PROTECTION
|--------------------------------------------------------------------------
*/

function sameOriginMutation(req) {
  const origin =
    req.headers.origin;

  if (!origin) {
    return true;
  }

  try {
    return (
      new URL(origin).host ===
      req.headers.host
    );
  } catch {
    return false;
  }
}

function requireMutation(
  req,
  res
) {
  if (
    !sameOriginMutation(req)
  ) {
    sendJson(
      res,
      403,
      {
        error:
          'Cross-site request blocked.'
      }
    );

    return false;
  }

  return true;
}

/*
|--------------------------------------------------------------------------
| ADMIN SEED
|--------------------------------------------------------------------------
*/

async function seedAdmin() {
  const d = db();

  let admin =
    d.users.find(
      u =>
        u.role === 'admin' &&
        u.email ===
          ADMIN_EMAIL
    );

  if (!admin) {
    if (
      !validPassword(
        ADMIN_INITIAL_PASSWORD
      )
    ) {
      throw new Error(
        'ADMIN_INITIAL_PASSWORD must be at least 10 characters and contain letters and numbers.'
      );
    }

    const hp =
      hashPassword(
        ADMIN_INITIAL_PASSWORD
      );

    admin = {
      id: id(),
      role: 'admin',
      name: 'Administrator',
      email: ADMIN_EMAIL,
      passwordHash:
        hp.hash,
      passwordSalt:
        hp.salt,
      passwordIterations:
        hp.iterations,
      createdAt: now()
    };

    d.users.push(admin);

    await atomicSave(d);

    console.log(
      `Created admin account: ${ADMIN_EMAIL}`
    );
  }
}

/*
|--------------------------------------------------------------------------
| API
|--------------------------------------------------------------------------
*/

async function api(
  req,
  res,
  p
) {
  const d = db();

  /*
  |--------------------------------------------------------------------------
  | HEALTH
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'GET' &&
    p === '/api/health'
  ) {
    return sendJson(
      res,
      200,
      {
        ok: true,
        service: 'homework-genie'
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | STUDENT REGISTER
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'POST' &&
    p ===
      '/api/auth/register'
  ) {
    if (
      !rateLimit(
        req,
        'register',
        8,
        15 * 60 * 1000
      )
    ) {
      return sendJson(
        res,
        429,
        {
          error:
            'Too many registration attempts. Try again later.'
        }
      );
    }

    const x =
      await jsonBody(req);

    const email =
      String(
        x.email || ''
      )
        .trim()
        .toLowerCase();

    if (!validateEmail(email)) {
      return sendJson(
        res,
        400,
        {
          error:
            'Please use a valid email address.'
        }
      );
    }

    if (
      !validPassword(
        x.password
      )
    ) {
      return sendJson(
        res,
        400,
        {
          error:
            'Password must be at least 10 characters and include a letter and a number.'
        }
      );
    }

    if (
      d.users.some(
        u =>
          u.email ===
          email
      )
    ) {
      return sendJson(
        res,
        409,
        {
          error:
            'Account already exists.'
        }
      );
    }

    const hp =
      hashPassword(
        x.password
      );

    const user = {
      id: id(),
      role: 'student',
      name: String(
        x.name || ''
      )
        .trim()
        .slice(0, 120),
      phone: String(
        x.phone || ''
      )
        .trim()
        .slice(0, 50),
      email,
      passwordHash:
        hp.hash,
      passwordSalt:
        hp.salt,
      passwordIterations:
        hp.iterations,
      education: String(
        x.education || ''
      )
        .trim()
        .slice(0, 120),
      createdAt: now()
    };

    d.users.push(user);

    await atomicSave(d);

    setSession(
      res,
      {
        sub: user.id,
        role: 'student'
      }
    );

    return sendJson(
      res,
      201,
      {
        user:
          publicUser(user)
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | STUDENT LOGIN
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'POST' &&
    p ===
      '/api/auth/login'
  ) {
    if (
      !rateLimit(
        req,
        'login',
        10,
        15 * 60 * 1000
      )
    ) {
      return sendJson(
        res,
        429,
        {
          error:
            'Too many login attempts. Try again later.'
        }
      );
    }

    const x =
      await jsonBody(req);

    const email =
      String(
        x.email || ''
      )
        .trim()
        .toLowerCase();

    const u =
      d.users.find(
        v =>
          v.email ===
            email &&
          v.role ===
            'student'
      );

    if (
      !u ||
      !verifyPassword(
        x.password || '',
        u
      )
    ) {
      return sendJson(
        res,
        401,
        {
          error:
            'Incorrect email or password.'
        }
      );
    }

    setSession(
      res,
      {
        sub: u.id,
        role: u.role
      }
    );

    return sendJson(
      res,
      200,
      {
        user:
          publicUser(u)
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | ADMIN LOGIN
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'POST' &&
    p ===
      '/api/auth/admin-login'
  ) {
    if (
      !rateLimit(
        req,
        'admin-login',
        6,
        15 * 60 * 1000
      )
    ) {
      return sendJson(
        res,
        429,
        {
          error:
            'Too many admin login attempts. Try again later.'
        }
      );
    }

    const x =
      await jsonBody(req);

    const email =
      String(
        x.email || ''
      )
        .trim()
        .toLowerCase();

    const u =
      d.users.find(
        v =>
          v.email ===
            email &&
          v.role ===
            'admin'
      );

    if (
      !u ||
      !verifyPassword(
        x.password || '',
        u
      )
    ) {
      return sendJson(
        res,
        401,
        {
          error:
            'Invalid admin credentials.'
        }
      );
    }

    setSession(
      res,
      {
        sub: u.id,
        role: 'admin'
      }
    );

    return sendJson(
      res,
      200,
      {
        admin: {
          email:
            u.email,
          name:
            u.name
        }
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | LOGOUT
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'POST' &&
    p ===
      '/api/auth/logout'
  ) {
    clearSession(res);

    return sendJson(
      res,
      200,
      {
        ok: true
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | CURRENT USER
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'GET' &&
    p === '/api/me'
  ) {
    const a =
      auth(req);

    if (!a) {
      return sendJson(
        res,
        401,
        {
          error:
            'Unauthorized'
        }
      );
    }

    const u =
      d.users.find(
        v =>
          v.id ===
          a.sub
      );

    if (!u) {
      return sendJson(
        res,
        401,
        {
          error:
            'Session no longer valid.'
        }
      );
    }

    return sendJson(
      res,
      200,
      {
        user:
          publicUser(u)
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | STUDENT PROFILE
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'PUT' &&
    p ===
      '/api/student/profile'
  ) {
    if (
      !requireMutation(
        req,
        res
      )
    ) {
      return;
    }

    const r =
      requireAuth(
        req,
        'student'
      );

    if (r.error) {
      return sendJson(
        res,
        r.status,
        {
          error:
            r.error
        }
      );
    }

    const x =
      await jsonBody(req);

    const u =
      d.users.find(
        v =>
          v.id ===
          r.auth.sub
      );

    if (!u) {
      return sendJson(
        res,
        404,
        {
          error:
            'Student not found.'
        }
      );
    }

    u.name =
      String(
        x.name ||
          u.name
      )
        .trim()
        .slice(0, 120);

    u.phone =
      String(
        x.phone ||
          u.phone
      )
        .trim()
        .slice(0, 50);

    u.education =
      String(
        x.education ||
          u.education
      )
        .trim()
        .slice(0, 120);

    await atomicSave(d);

    return sendJson(
      res,
      200,
      {
        user:
          publicUser(u)
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | FORGOT PASSWORD
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'POST' &&
    p ===
      '/api/auth/forgot-password'
  ) {
    if (
      !rateLimit(
        req,
        'forgot',
        5,
        15 * 60 * 1000
      )
    ) {
      return sendJson(
        res,
        429,
        {
          error:
            'Too many reset attempts. Try again later.'
        }
      );
    }

    const x =
      await jsonBody(req);

    const email =
      String(
        x.email || ''
      )
        .trim()
        .toLowerCase();

    const u =
      d.users.find(
        v =>
          v.email ===
            email &&
          v.role ===
            'student'
      );

    if (u) {
      const resetToken =
        issueResetToken(
          d,
          u.id
        );

      notify(
        d,
        'password_reset_requested',
        {
          userId:
            u.id,
          email:
            u.email
        }
      );

      await atomicSave(d);

      const resetUrl =
        `${APP_BASE_URL}/reset-password.html?token=${encodeURIComponent(
          resetToken
        )}`;

      await sendEmail({
        to: u.email,

        subject:
          'Reset Your Homework Genie Password',

        text: `
You requested a password reset for your Homework Genie account.

Reset your password here:

${resetUrl}

This link expires in 30 minutes.

If you did not request this reset, you can safely ignore this email.
`.trim(),

        html: `
          <div style="font-family:Arial,sans-serif;line-height:1.6">
            <h2>Password Reset</h2>

            <p>
              You requested a password reset for your Homework Genie account.
            </p>

            <p>
              <a
                href="${escapeHtml(resetUrl)}"
                style="
                  display:inline-block;
                  padding:12px 20px;
                  background:#111827;
                  color:white;
                  text-decoration:none;
                  border-radius:6px;
                "
              >
                Reset Password
              </a>
            </p>

            <p>
              This link expires in 30 minutes.
            </p>

            <p>
              If you did not request this reset, you can safely ignore this email.
            </p>
          </div>
        `
      });

      if (
        process.env.NODE_ENV !==
        'production'
      ) {
        return sendJson(
          res,
          200,
          {
            message:
              'Reset request created for local testing.',
            devResetToken:
              resetToken
          }
        );
      }
    }

    return sendJson(
      res,
      200,
      {
        message:
          'If an account exists for this email, reset instructions have been issued.'
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | RESET PASSWORD
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'POST' &&
    p ===
      '/api/auth/reset-password'
  ) {
    if (
      !requireMutation(
        req,
        res
      )
    ) {
      return;
    }

    const x =
      await jsonBody(req);

    const reset =
      consumeResetToken(
        d,
        x.token
      );

    if (!reset) {
      return sendJson(
        res,
        400,
        {
          error:
            'Invalid, expired, or already-used reset token.'
        }
      );
    }

    const u =
      d.users.find(
        v =>
          v.id ===
            reset.userId &&
          v.role ===
            'student'
      );

    if (!u) {
      return sendJson(
        res,
        404,
        {
          error:
            'Account not found.'
        }
      );
    }

    if (
      !validPassword(
        x.password
      )
    ) {
      return sendJson(
        res,
        400,
        {
          error:
            'Password must be at least 10 characters and include a letter and a number.'
        }
      );
    }

    const hp =
      hashPassword(
        x.password
      );

    u.passwordHash =
      hp.hash;

    u.passwordSalt =
      hp.salt;

    u.passwordIterations =
      hp.iterations;

    await atomicSave(d);

    return sendJson(
      res,
      200,
      {
        ok: true
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | ADMIN CHANGE PASSWORD
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'POST' &&
    p ===
      '/api/admin/password'
  ) {
    if (
      !requireMutation(
        req,
        res
      )
    ) {
      return;
    }

    const r =
      requireAuth(
        req,
        'admin'
      );

    if (r.error) {
      return sendJson(
        res,
        r.status,
        {
          error:
            r.error
        }
      );
    }

    const x =
      await jsonBody(req);

    const u =
      d.users.find(
        v =>
          v.id ===
            r.auth.sub &&
          v.role ===
            'admin'
      );

    if (
      !u ||
      !verifyPassword(
        x.currentPassword ||
          '',
        u
      )
    ) {
      return sendJson(
        res,
        401,
        {
          error:
            'Current password is incorrect.'
        }
      );
    }

    if (
      !validPassword(
        x.newPassword
      )
    ) {
      return sendJson(
        res,
        400,
        {
          error:
            'New password must be at least 10 characters and include a letter and a number.'
        }
      );
    }

    const hp =
      hashPassword(
        x.newPassword
      );

    u.passwordHash =
      hp.hash;

    u.passwordSalt =
      hp.salt;

    u.passwordIterations =
      hp.iterations;

    await atomicSave(d);

    clearSession(res);

    return sendJson(
      res,
      200,
      {
        ok: true,
        message:
          'Password changed. Please sign in again.'
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | GUEST QUOTE REQUEST
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'POST' &&
    p ===
      '/api/quote-requests'
  ) {
    if (
      !requireMutation(
        req,
        res
      )
    ) {
      return;
    }

    if (
      !rateLimit(
        req,
        'quote-request',
        12,
        15 * 60 * 1000
      )
    ) {
      return sendJson(
        res,
        429,
        {
          error:
            'Too many requests. Try again later.'
        }
      );
    }

    const x =
      await jsonBody(req);

    for (
      const k of [
        'name',
        'email',
        'phone',
        'service',
        'subject',
        'title',
        'description',
        'deadline'
      ]
    ) {
      if (
        !String(
          x[k] || ''
        ).trim()
      ) {
        return sendJson(
          res,
          400,
          {
            error:
              `Missing required field: ${k}`
          }
        );
      }
    }

    const email =
      String(x.email)
        .trim()
        .toLowerCase();

    if (
      !validateEmail(email)
    ) {
      return sendJson(
        res,
        400,
        {
          error:
            'Please enter a valid email address.'
        }
      );
    }

    const request = {
      id: id(),

      type:
        'guest_quote',

      name:
        String(x.name)
          .trim()
          .slice(0, 120),

      email,

      phone:
        String(x.phone)
          .trim()
          .slice(0, 50),

      service:
        String(x.service)
          .trim()
          .slice(0, 120),

      subject:
        String(x.subject)
          .trim()
          .slice(0, 160),

      title:
        String(x.title)
          .trim()
          .slice(0, 200),

      description:
        String(x.description)
          .trim()
          .slice(0, 8000),

      deadline:
        String(x.deadline)
          .trim()
          .slice(0, 80),

      length:
        String(x.length || '')
          .trim()
          .slice(0, 80),

      instructions:
        String(
          x.instructions || ''
        )
          .trim()
          .slice(0, 4000),

      status:
        'request_received',

      createdAt: now(),

      files: []
    };

    request.files =
      storeFiles(
        x.files || [],
        null,
        request.id
      );

    d.requests.unshift(
      request
    );

    notify(
      d,
      'new_quote_request',
      {
        requestId:
          request.id,
        title:
          request.title,
        name:
          request.name,
        email:
          request.email
      }
    );

    await atomicSave(d);

    /*
     * Send email AFTER the request has safely been saved.
     * Email failure therefore does not destroy the request.
     */

    const emailResult =
      await sendNewRequestEmail(
        request
      );

    return sendJson(
      res,
      201,
      {
        request: {
          ...request,
          files:
            publicFiles(
              request.files
            )
        },

        email:
          emailResult.sent
            ? 'sent'
            : 'not_sent'
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | REGISTERED STUDENT ASSIGNMENT
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'POST' &&
    p ===
      '/api/assignments'
  ) {
    if (
      !requireMutation(
        req,
        res
      )
    ) {
      return;
    }

    const r =
      requireAuth(
        req,
        'student'
      );

    if (r.error) {
      return sendJson(
        res,
        r.status,
        {
          error:
            r.error
        }
      );
    }

    const x =
      await jsonBody(req);

    for (
      const k of [
        'service',
        'subject',
        'title',
        'deadline',
        'details'
      ]
    ) {
      if (
        !String(
          x[k] || ''
        ).trim()
      ) {
        return sendJson(
          res,
          400,
          {
            error:
              `Missing required field: ${k}`
          }
        );
      }
    }

    const user =
      d.users.find(
        v =>
          v.id ===
          r.auth.sub
      );

    if (!user) {
      return sendJson(
        res,
        401,
        {
          error:
            'Student account not found.'
        }
      );
    }

    const aid = id();

    const files =
      storeFiles(
        x.files || [],
        user.id,
        aid
      );

    const item = {
      id: aid,

      userId:
        user.id,

      student: {
        name:
          user.name,

        email:
          user.email,

        phone:
          user.phone
      },

      service:
        String(x.service)
          .trim()
          .slice(0, 120),

      subject:
        String(x.subject)
          .trim()
          .slice(0, 160),

      title:
        String(x.title)
          .trim()
          .slice(0, 200),

      deadline:
        String(x.deadline)
          .trim()
          .slice(0, 80),

      preferredDelivery:
        String(
          x.preferredDelivery ||
            ''
        )
          .trim()
          .slice(0, 80),

      budget:
        String(
          x.budget || ''
        )
          .trim()
          .slice(0, 80),

      details:
        String(x.details)
          .trim()
          .slice(0, 8000),

      instructions:
        String(
          x.instructions || ''
        )
          .trim()
          .slice(0, 4000),

      status:
        'request_received',

      paymentStatus:
        'not_applicable',

      files,

      createdAt:
        now()
    };

    d.assignments.unshift(
      item
    );

    notify(
      d,
      'new_assignment',
      {
        assignmentId:
          item.id,
        title:
          item.title,
        student:
          user.name,
        email:
          user.email
      }
    );

    await atomicSave(d);

    await sendEmail({
      to:
        ADMIN_NOTIFICATION_EMAIL,

      subject:
        `New Assignment — ${item.id}`,

      text: `
A registered student has submitted a new assignment.

Student: ${user.name}
Email: ${user.email}
Assignment: ${item.title}
Service: ${item.service}
Deadline: ${item.deadline}
`.trim(),

      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6">
          <h2>New Assignment</h2>

          <p>
            A registered student has submitted a new assignment.
          </p>

          <p>
            <strong>Student:</strong>
            ${escapeHtml(user.name)}
          </p>

          <p>
            <strong>Email:</strong>
            ${escapeHtml(user.email)}
          </p>

          <p>
            <strong>Assignment:</strong>
            ${escapeHtml(item.title)}
          </p>

          <p>
            <strong>Service:</strong>
            ${escapeHtml(item.service)}
          </p>

          <p>
            <strong>Deadline:</strong>
            ${escapeHtml(item.deadline)}
          </p>

          <p>
            <a href="${escapeHtml(
              APP_BASE_URL
            )}/admin.html">
              Open Admin Dashboard
            </a>
          </p>
        </div>
      `
    });

    return sendJson(
      res,
      201,
      {
        assignment:
          item
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | STUDENT REQUESTS / QUOTES / INVOICES
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'GET' &&
    p ===
      '/api/student/requests'
  ) {
    const r =
      requireAuth(
        req,
        'student'
      );

    if (r.error) {
      return sendJson(
        res,
        r.status,
        {
          error:
            r.error
        }
      );
    }

    const u =
      d.users.find(
        v =>
          v.id ===
          r.auth.sub
      );

    if (!u) {
      return sendJson(
        res,
        401,
        {
          error:
            'Student not found.'
        }
      );
    }

    return sendJson(
      res,
      200,
      {
        requests:
          d.requests
            .filter(
              x =>
                x.email ===
                u.email
            )
            .map(
              x => ({
                ...x,
                files:
                  publicFiles(
                    x.files
                  )
              })
            ),

        assignments:
          d.assignments.filter(
            x =>
              x.userId ===
              u.id
          ),

        quotes:
          d.quotes.filter(
            x =>
              x.userId ===
              u.id
          ),

        invoices:
          d.invoices.filter(
            x =>
              x.userId ===
              u.id
          )
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | ADMIN DASHBOARD
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'GET' &&
    p ===
      '/api/admin/dashboard'
  ) {
    const r =
      requireAuth(
        req,
        'admin'
      );

    if (r.error) {
      return sendJson(
        res,
        r.status,
        {
          error:
            r.error
        }
      );
    }

    const pendingQuotes =
      d.quotes.filter(
        q =>
          q.status ===
          'sent'
      ).length;

    const pendingInvoices =
      d.invoices.filter(
        i =>
          i.status ===
          'pending_payment'
      ).length;

    const needsAttention =
      d.requests.filter(
        x =>
          [
            'request_received',
            'under_review'
          ].includes(
            x.status
          )
      ).length +

      d.assignments.filter(
        x =>
          [
            'request_received',
            'under_review'
          ].includes(
            x.status
          )
      ).length +

      d.invoices.filter(
        i =>
          i.status ===
          'overdue'
      ).length;

    return sendJson(
      res,
      200,
      {
        summary: {
          newRequests:
            d.requests.filter(
              x =>
                x.status ===
                'request_received'
            ).length,

          assignments:
            d.assignments.length,

          pendingQuotes,

          pendingInvoices,

          paymentsReceived:
            d.payments.filter(
              x =>
                x.status ===
                'paid'
            ).length,

          needsAttention,

          students:
            d.users.filter(
              u =>
                u.role ===
                'student'
            ).length,

          guestLeads:
            d.requests.length
        },

        users:
          d.users
            .filter(
              u =>
                u.role ===
                'student'
            )
            .map(
              publicUser
            ),

        requests:
          d.requests,

        assignments:
          d.assignments,

        quotes:
          d.quotes,

        invoices:
          d.invoices,

        payments:
          d.payments,

        notifications:
          d.notifications.slice(
            0,
            50
          )
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | TEMPORARY SMTP TEST ENDPOINT
  |--------------------------------------------------------------------------
  | This is protected by admin authentication.
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'POST' &&
    p ===
      '/api/admin/test-email'
  ) {
    if (
      !requireMutation(
        req,
        res
      )
    ) {
      return;
    }

    const r =
      requireAuth(
        req,
        'admin'
      );

    if (r.error) {
      return sendJson(
        res,
        r.status,
        {
          error:
            r.error
        }
      );
    }

    const x =
      await jsonBody(req);

    const to =
      String(
        x.to || ''
      ).trim();

    if (
      !validateEmail(to)
    ) {
      return sendJson(
        res,
        400,
        {
          error:
            'Please provide a valid test email address.'
        }
      );
    }

    const result =
      await sendEmail({
        to,

        subject:
          'Homework Genie SMTP Test',

        text: `
This is a test email from Homework Genie.

If you received this message, your SMTP configuration is working correctly.
`.trim(),

        html: `
          <div style="font-family:Arial,sans-serif;line-height:1.6">
            <h2>Homework Genie SMTP Test</h2>

            <p>
              This is a test email from Homework Genie.
            </p>

            <p>
              If you received this message, your SMTP configuration is working correctly.
            </p>

            <p>
              Sent from:
              <strong>admin@homeworkgenie.online</strong>
            </p>
          </div>
        `
      });

    if (!result.sent) {
      return sendJson(
        res,
        500,
        {
          error:
            'Email could not be sent.',
          details:
            result.error ||
            result.reason
        }
      );
    }

    return sendJson(
      res,
      200,
      {
        ok: true,

        message:
          'Test email sent successfully.',

        messageId:
          result.messageId
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | GUEST QUOTE VIEW
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'GET' &&
    p.startsWith(
      '/api/guest/quotes/'
    )
  ) {
    const raw =
      p.split('/')[4];

    const q =
      d.quotes.find(
        x =>
          x.guestTokenHash ===
            hashOpaqueToken(
              raw
            ) &&
          [
            'sent',
            'accepted'
          ].includes(
            x.status
          )
      );

    if (!q) {
      return sendJson(
        res,
        404,
        {
          error:
            'Quote link is invalid, expired, or already claimed.'
        }
      );
    }

    if (
      q.expiryDate &&
      new Date(
        q.expiryDate
      ).getTime() <
        Date.now() &&
      q.status === 'sent'
    ) {
      return sendJson(
        res,
        410,
        {
          error:
            'This quote has expired.'
        }
      );
    }

    return sendJson(
      res,
      200,
      {
        quote: {
          quoteNumber:
            q.quoteNumber,

          student:
            q.student,

          service:
            q.service,

          subject:
            q.subject,

          title:
            q.title,

          description:
            q.description,

          basePrice:
            q.basePrice,

          additionalCharges:
            q.additionalCharges,

          price:
            q.price,

          deadline:
            q.deadline,

          terms:
            q.terms,

          dateIssued:
            q.dateIssued,

          expiryDate:
            q.expiryDate,

          status:
            q.status
        }
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | GUEST QUOTE RESPONSE
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'POST' &&
    p.startsWith(
      '/api/guest/quotes/'
    ) &&
    p.endsWith(
      '/respond'
    )
  ) {
    if (
      !requireMutation(
        req,
        res
      )
    ) {
      return;
    }

    const raw =
      p.split('/')[4];

    const q =
      d.quotes.find(
        x =>
          x.guestTokenHash ===
            hashOpaqueToken(
              raw
            ) &&
          x.status ===
            'sent'
      );

    if (!q) {
      return sendJson(
        res,
        404,
        {
          error:
            'Quote link is invalid or expired.'
        }
      );
    }

    const x =
      await jsonBody(req);

    if (
      ![
        'accepted',
        'declined',
        'changes_requested'
      ].includes(
        x.action
      )
    ) {
      return sendJson(
        res,
        400,
        {
          error:
            'Invalid quote response.'
        }
      );
    }

    q.status =
      x.action;

    q.responseNote =
      String(
        x.note || ''
      )
        .trim()
        .slice(0, 3000);

    q.respondedAt =
      now();

    let invoice = null;

    if (
      x.action ===
      'accepted'
    ) {
      invoice = {
        id: id(),

        invoiceNumber:
          nextNumber(
            'INV',
            d.invoices
          ),

        quoteId:
          q.id,

        userId:
          null,

        email:
          q.student.email,

        amount:
          q.price,

        status:
          'pending_payment',

        date:
          now(),

        dueDate:
          q.expiryDate ||
          null,

        service:
          q.service,

        guestAccessTokenHash:
          hashOpaqueToken(
            raw
          )
      };

      d.invoices.unshift(
        invoice
      );

      const source =
        findRequest(
          d,
          q.requestId
        );

      if (source) {
        source.status =
          'payment_pending';
      }

      notify(
        d,
        'quote_accepted',
        {
          quoteId:
            q.id,

          invoiceId:
            invoice.id,

          email:
            q.student.email
        }
      );
    } else {
      notify(
        d,
        'quote_response',
        {
          quoteId:
            q.id,

          action:
            x.action,

          email:
            q.student.email
        }
      );
    }

    await atomicSave(d);

    if (
      x.action ===
        'accepted' &&
      invoice
    ) {
      await sendQuoteAcceptedEmail(
        q,
        invoice
      );
    }

    await sendEmail({
      to:
        ADMIN_NOTIFICATION_EMAIL,

      subject:
        `Quote ${q.quoteNumber} — ${x.action}`,

      text: `
Quote ${q.quoteNumber} received a response.

Client: ${q.student.name}
Email: ${q.student.email}
Response: ${x.action}
${x.note ? `Note: ${x.note}` : ''}
`.trim(),

      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6">
          <h2>Quote Response</h2>

          <p>
            <strong>Quote:</strong>
            ${escapeHtml(q.quoteNumber)}
          </p>

          <p>
            <strong>Client:</strong>
            ${escapeHtml(q.student.name)}
          </p>

          <p>
            <strong>Email:</strong>
            ${escapeHtml(q.student.email)}
          </p>

          <p>
            <strong>Response:</strong>
            ${escapeHtml(x.action)}
          </p>

          ${
            x.note
              ? `
                <p>
                  <strong>Note:</strong>
                  ${escapeHtml(x.note)}
                </p>
              `
              : ''
          }
        </div>
      `
    });

    return sendJson(
      res,
      200,
      {
        quote: {
          quoteNumber:
            q.quoteNumber,

          status:
            q.status
        },

        invoice
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | GUEST CLAIM / CREATE ACCOUNT
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'POST' &&
    p.startsWith(
      '/api/guest/quotes/'
    ) &&
    p.endsWith(
      '/claim'
    )
  ) {
    if (
      !requireMutation(
        req,
        res
      )
    ) {
      return;
    }

    const raw =
      p.split('/')[4];

    const q =
      d.quotes.find(
        x =>
          x.guestTokenHash ===
            hashOpaqueToken(
              raw
            ) &&
          x.status ===
            'accepted'
      );

    if (!q) {
      return sendJson(
        res,
        404,
        {
          error:
            'This guest quote cannot be claimed.'
        }
      );
    }

    const x =
      await jsonBody(req);

    const email =
      String(
        x.email || ''
      )
        .trim()
        .toLowerCase();

    if (
      email !==
      String(
        q.student.email ||
          ''
      ).toLowerCase()
    ) {
      return sendJson(
        res,
        403,
        {
          error:
            'Email does not match the quote.'
        }
      );
    }

    if (
      !validPassword(
        x.password
      )
    ) {
      return sendJson(
        res,
        400,
        {
          error:
            'Password must be at least 10 characters and include a letter and a number.'
        }
      );
    }

    if (
      d.users.some(
        u =>
          u.email ===
          email
      )
    ) {
      return sendJson(
        res,
        409,
        {
          error:
            'An account already exists for this email. Please use the normal login.'
        }
      );
    }

    const hp =
      hashPassword(
        x.password
      );

    const user = {
      id: id(),

      role:
        'student',

      name:
        String(
          x.name ||
            q.student.name ||
            ''
        )
          .trim()
          .slice(0, 120),

      phone:
        String(
          x.phone ||
            q.student.phone ||
            ''
        )
          .trim()
          .slice(0, 50),

      email,

      passwordHash:
        hp.hash,

      passwordSalt:
        hp.salt,

      passwordIterations:
        hp.iterations,

      education:
        '',

      createdAt:
        now(),

      claimedFromQuoteId:
        q.id
    };

    d.users.push(
      user
    );

    q.userId =
      user.id;

    q.guestTokenHash =
      null;

    const source =
      findRequest(
        d,
        q.requestId
      );

    if (source) {
      source.userId =
        user.id;

      if (
        source.type ===
        'guest_quote'
      ) {
        source.type =
          'client_quote';

        source.claimedAt =
          now();
      }
    }

    for (
      const inv of
        d.invoices.filter(
          i =>
            i.quoteId ===
            q.id
        )
    ) {
      inv.userId =
        user.id;

      inv.email =
        email;

      inv.guestAccessTokenHash =
        null;
    }

    notify(
      d,
      'guest_converted',
      {
        quoteId:
          q.id,

        userId:
          user.id,

        email
      }
    );

    await atomicSave(d);

    setSession(
      res,
      {
        sub:
          user.id,

        role:
          'student'
      }
    );

    return sendJson(
      res,
      201,
      {
        user:
          publicUser(user)
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | ADMIN VIEW REQUEST
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'GET' &&
    p.startsWith(
      '/api/admin/requests/'
    )
  ) {
    const r =
      requireAuth(
        req,
        'admin'
      );

    if (r.error) {
      return sendJson(
        res,
        r.status,
        {
          error:
            r.error
        }
      );
    }

    const item =
      findRequest(
        d,
        p.split('/')[4]
      );

    if (!item) {
      return sendJson(
        res,
        404,
        {
          error:
            'Request not found.'
        }
      );
    }

    return sendJson(
      res,
      200,
      {
        item: {
          ...item,

          files:
            publicFiles(
              item.files
            )
        }
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | ADMIN CREATE QUOTE
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'POST' &&
    p ===
      '/api/admin/quotes'
  ) {
    if (
      !requireMutation(
        req,
        res
      )
    ) {
      return;
    }

    const r =
      requireAuth(
        req,
        'admin'
      );

    if (r.error) {
      return sendJson(
        res,
        r.status,
        {
          error:
            r.error
        }
      );
    }

    const x =
      await jsonBody(req);

    const source =
      findRequest(
        d,
        x.requestId
      );

    if (!source) {
      return sendJson(
        res,
        404,
        {
          error:
            'Request not found.'
        }
      );
    }

    const base =
      Number(
        x.basePrice
      );

    const extra =
      Number(
        x.additionalCharges ||
          0
      );

    if (
      !Number.isFinite(
        base
      ) ||
      base < 0 ||
      !Number.isFinite(
        extra
      ) ||
      extra < 0
    ) {
      return sendJson(
        res,
        400,
        {
          error:
            'Enter valid quote amounts.'
        }
      );
    }

    const total =
      Math.round(
        (base + extra) *
          100
      ) / 100;

    const guestToken =
      source.userId
        ? null
        : issueGuestToken();

    const quote = {
      id: id(),

      quoteNumber:
        nextNumber(
          'Q',
          d.quotes
        ),

      requestId:
        source.id,

      userId:
        source.userId ||
        null,

      guestTokenHash:
        guestToken
          ? hashOpaqueToken(
              guestToken
            )
          : null,

      student: {
        name:
          source.name ||
          source.student?.name,

        email:
          source.email ||
          source.student?.email,

        phone:
          source.phone ||
          source.student?.phone
      },

      service:
        source.service,

      subject:
        source.subject,

      title:
        source.title,

      description:
        source.description ||
        source.details ||
        '',

      basePrice:
        base,

      additionalCharges:
        extra,

      price:
        total,

      deadline:
        source.deadline,

      terms:
        String(
          x.terms || ''
        )
          .trim()
          .slice(0, 5000),

      dateIssued:
        now(),

      expiryDate:
        x.expiryDate ||
        null,

      status:
        'sent'
    };

    d.quotes.unshift(
      quote
    );

    source.status =
      'quote_sent';

    notify(
      d,
      'quote_sent',
      {
        quoteId:
          quote.id,

        quoteNumber:
          quote.quoteNumber,

        email:
          quote.student.email
      }
    );

    await atomicSave(d);

    /*
     * Generate secure client quote URL.
     *
     * Registered clients can later access their quote
     * through their account.
     *
     * Guests receive a unique tokenized URL.
     */

    let quoteUrl =
      `${APP_BASE_URL}/guest-quote.html`;

    if (guestToken) {
      quoteUrl +=
        `?token=${encodeURIComponent(
          guestToken
        )}`;
    }

    const emailResult =
      await sendQuoteEmail(
        quote,
        quoteUrl
      );

    return sendJson(
      res,
      201,
      {
        quote,

        guestQuoteToken:
          guestToken ||
          undefined,

        quoteUrl,

        email:
          emailResult.sent
            ? 'sent'
            : 'not_sent'
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | REGISTERED CLIENT QUOTE RESPONSE
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'POST' &&
    p.startsWith(
      '/api/quotes/'
    ) &&
    p.endsWith(
      '/respond'
    )
  ) {
    if (
      !requireMutation(
        req,
        res
      )
    ) {
      return;
    }

    const r =
      requireAuth(
        req,
        'student'
      );

    if (r.error) {
      return sendJson(
        res,
        r.status,
        {
          error:
            r.error
        }
      );
    }

    const qid =
      p.split('/')[3];

    const x =
      await jsonBody(req);

    const q =
      d.quotes.find(
        v =>
          v.id ===
            qid &&
          v.userId ===
            r.auth.sub
      );

    if (!q) {
      return sendJson(
        res,
        404,
        {
          error:
            'Quote not found.'
        }
      );
    }

    if (
      ![
        'accepted',
        'declined',
        'changes_requested'
      ].includes(
        x.action
      )
    ) {
      return sendJson(
        res,
        400,
        {
          error:
            'Invalid quote response.'
        }
      );
    }

    if (
      q.status !==
      'sent'
    ) {
      return sendJson(
        res,
        409,
        {
          error:
            'This quote is no longer awaiting a response.'
        }
      );
    }

    q.status =
      x.action;

    q.responseNote =
      String(
        x.note || ''
      )
        .trim()
        .slice(0, 3000);

    q.respondedAt =
      now();

    let invoice = null;

    if (
      x.action ===
      'accepted'
    ) {
      const source =
        findRequest(
          d,
          q.requestId
        );

      if (source) {
        source.status =
          'payment_pending';
      }

      invoice = {
        id: id(),

        invoiceNumber:
          nextNumber(
            'INV',
            d.invoices
          ),

        quoteId:
          q.id,

        userId:
          r.auth.sub,

        email:
          q.student.email,

        amount:
          q.price,

        status:
          'pending_payment',

        date:
          now(),

        dueDate:
          q.expiryDate ||
          null,

        service:
          q.service
      };

      d.invoices.unshift(
        invoice
      );

      notify(
        d,
        'quote_accepted',
        {
          quoteId:
            q.id,

          invoiceId:
            invoice.id,

          email:
            q.student.email
        }
      );
    } else {
      notify(
        d,
        'quote_response',
        {
          quoteId:
            q.id,

          action:
            x.action,

          email:
            q.student.email
        }
      );
    }

    await atomicSave(d);

    if (
      x.action ===
        'accepted' &&
      invoice
    ) {
      await sendQuoteAcceptedEmail(
        q,
        invoice
      );
    }

    return sendJson(
      res,
      200,
      {
        quote: q,
        invoice
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | ADMIN REQUEST STATUS
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'POST' &&
    p.startsWith(
      '/api/admin/requests/'
    ) &&
    p.endsWith(
      '/status'
    )
  ) {
    if (
      !requireMutation(
        req,
        res
      )
    ) {
      return;
    }

    const r =
      requireAuth(
        req,
        'admin'
      );

    if (r.error) {
      return sendJson(
        res,
        r.status,
        {
          error:
            r.error
        }
      );
    }

    const item =
      findRequest(
        d,
        p.split('/')[4]
      );

    if (!item) {
      return sendJson(
        res,
        404,
        {
          error:
            'Request not found.'
        }
      );
    }

    const x =
      await jsonBody(req);

    if (
      !STATUS_VALUES.has(
        x.status
      )
    ) {
      return sendJson(
        res,
        400,
        {
          error:
            'Invalid status.'
        }
      );
    }

    item.status =
      x.status;

    item.updatedAt =
      now();

    notify(
      d,
      'status_update',
      {
        requestId:
          item.id,

        status:
          item.status,

        email:
          item.email ||
          item.student?.email
      }
    );

    await atomicSave(d);

    const recipient =
      item.email ||
      item.student?.email;

    if (
      recipient &&
      validateEmail(
        recipient
      )
    ) {
      await sendEmail({
        to:
          recipient,

        subject:
          `Homework Genie Status Update — ${item.status}`,

        text: `
Your Homework Genie request has been updated.

Current status:
${item.status}
`.trim(),

        html: `
          <div style="font-family:Arial,sans-serif;line-height:1.6">
            <h2>Homework Genie Status Update</h2>

            <p>
              Your request status has been updated.
            </p>

            <p>
              <strong>Status:</strong>
              ${escapeHtml(item.status)}
            </p>

            <p>
              Thank you,<br>
              <strong>Homework Genie</strong>
            </p>
          </div>
        `
      });
    }

    return sendJson(
      res,
      200,
      {
        item
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | ADMIN RECORD PAYMENT
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'POST' &&
    p.startsWith(
      '/api/admin/payments'
    )
  ) {
    if (
      !requireMutation(
        req,
        res
      )
    ) {
      return;
    }

    const r =
      requireAuth(
        req,
        'admin'
      );

    if (r.error) {
      return sendJson(
        res,
        r.status,
        {
          error:
            r.error
        }
      );
    }

    const x =
      await jsonBody(req);

    const inv =
      d.invoices.find(
        i =>
          i.id ===
          x.invoiceId
      );

    if (!inv) {
      return sendJson(
        res,
        404,
        {
          error:
            'Invoice not found.'
        }
      );
    }

    if (
      inv.status ===
      'paid'
    ) {
      return sendJson(
        res,
        409,
        {
          error:
            'Invoice is already marked paid.'
        }
      );
    }

    const pay = {
      id: id(),

      invoiceId:
        inv.id,

      method:
        String(
          x.method ||
            'manual'
        ).slice(0, 50),

      amount:
        inv.amount,

      status:
        'paid',

      reference:
        String(
          x.reference ||
            ''
        ).slice(0, 120),

      receivedAt:
        now()
    };

    d.payments.unshift(
      pay
    );

    inv.status =
      'paid';

    notify(
      d,
      'payment_received',
      {
        invoiceId:
          inv.id,

        email:
          inv.email
      }
    );

    await atomicSave(d);

    await sendPaymentReceivedEmail(
      inv,
      pay
    );

    await sendEmail({
      to:
        ADMIN_NOTIFICATION_EMAIL,

      subject:
        `Payment Recorded — ${inv.invoiceNumber}`,

      text: `
Payment recorded for invoice ${inv.invoiceNumber}.

Amount: ${inv.amount}
Method: ${pay.method}
Reference: ${pay.reference || 'Not provided'}
`.trim(),

      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.6">
          <h2>Payment Recorded</h2>

          <p>
            <strong>Invoice:</strong>
            ${escapeHtml(inv.invoiceNumber)}
          </p>

          <p>
            <strong>Amount:</strong>
            ${escapeHtml(inv.amount)}
          </p>

          <p>
            <strong>Method:</strong>
            ${escapeHtml(pay.method)}
          </p>

          ${
            pay.reference
              ? `
                <p>
                  <strong>Reference:</strong>
                  ${escapeHtml(pay.reference)}
                </p>
              `
              : ''
          }
        </div>
      `
    });

    return sendJson(
      res,
      200,
      {
        payment: pay,
        invoice: inv
      }
    );
  }

  /*
  |--------------------------------------------------------------------------
  | PROTECTED FILES
  |--------------------------------------------------------------------------
  */

  if (
    req.method === 'GET' &&
    p.startsWith(
      '/api/files/'
    )
  ) {
    const a =
      auth(req);

    if (!a) {
      return sendJson(
        res,
        401,
        {
          error:
            'Unauthorized'
        }
      );
    }

    const fileId =
      p.split('/')[3];

    const f =
      findAllFiles(
        d
      ).find(
        v =>
          v.id ===
          fileId
      );

    if (!f) {
      return sendJson(
        res,
        404,
        {
          error:
            'File not found.'
        }
      );
    }

    if (
      a.role !==
        'admin' &&
      f.ownerId !==
        a.sub
    ) {
      return sendJson(
        res,
        403,
        {
          error:
            'Access denied.'
        }
      );
    }

    const fp =
      path.join(
        FILE_DIR,
        f.filename
      );

    if (
      !fs.existsSync(fp)
    ) {
      return sendJson(
        res,
        404,
        {
          error:
            'Stored file not found.'
        }
      );
    }

    res.writeHead(
      200,
      {
        'Content-Type':
          f.type ||
          'application/octet-stream',

        'Content-Disposition':
          `attachment; filename="${safeOriginalName(
            f.name
          )}"`,

        ...securityHeaders()
      }
    );

    return fs
      .createReadStream(fp)
      .pipe(res);
  }

  /*
  |--------------------------------------------------------------------------
  | UNKNOWN API
  |--------------------------------------------------------------------------
  */

  return sendJson(
    res,
    404,
    {
      error:
        'API route not found.'
    }
  );
}

/*
|--------------------------------------------------------------------------
| STATIC FILE SERVER
|--------------------------------------------------------------------------
*/

function mime(extn) {
  return {
    html:
      'text/html; charset=utf-8',

    css:
      'text/css; charset=utf-8',

    js:
      'text/javascript; charset=utf-8',

    json:
      'application/json; charset=utf-8',

    png:
      'image/png',

    jpg:
      'image/jpeg',

    jpeg:
      'image/jpeg',

    svg:
      'image/svg+xml',

    ico:
      'image/x-icon'
  }[extn] ||
    'application/octet-stream';
}

function staticFile(
  req,
  res,
  p
) {
  let rel =
    p === '/'
      ? 'index.html'
      : p.replace(
          /^\/+/,
          ''
        );

  const full =
    path.resolve(
      PUBLIC_DIR,
      rel
    );

  if (
    full !==
      PUBLIC_DIR &&
    !full.startsWith(
      PUBLIC_DIR +
        path.sep
    )
  ) {
    return sendJson(
      res,
      403,
      {
        error:
          'Forbidden'
      }
    );
  }

  if (
    !fs.existsSync(
      full
    ) ||
    fs.statSync(
      full
    ).isDirectory()
  ) {
    return sendJson(
      res,
      404,
      {
        error:
          'Not found.'
      }
    );
  }

  res.writeHead(
    200,
    {
      'Content-Type':
        mime(
          path
            .extname(full)
            .slice(1)
            .toLowerCase()
        ),

      ...securityHeaders()
    }
  );

  fs.createReadStream(
    full
  ).pipe(res);
}

/*
|--------------------------------------------------------------------------
| ROUTER
|--------------------------------------------------------------------------
*/

async function route(
  req,
  res
) {
  try {
    if (
      req.method ===
      'OPTIONS'
    ) {
      return sendNoContent(
        res
      );
    }

    const p =
      new URL(
        req.url,
        `http://${
          req.headers.host ||
          'localhost'
        }`
      ).pathname;

    if (
      p.startsWith(
        '/api/'
      )
    ) {
      return await api(
        req,
        res,
        p
      );
    }

    return staticFile(
      req,
      res,
      p
    );
  } catch (e) {
    console.error(e);

    return sendJson(
      res,
      500,
      {
        error:
          'Server error.'
      }
    );
  }
}

/*
|--------------------------------------------------------------------------
| CREATE SERVER
|--------------------------------------------------------------------------
| This was missing from the version you uploaded.
|--------------------------------------------------------------------------
*/

const server =
  http.createServer(
    route
  );

/*
|--------------------------------------------------------------------------
| STARTUP
|--------------------------------------------------------------------------
*/

(async () => {
  if (process.env.NODE_ENV === 'production') {
    const missing = [];

    if (!process.env.SESSION_SECRET) {
      missing.push('SESSION_SECRET');
    }

    if (!process.env.ADMIN_INITIAL_PASSWORD) {
      missing.push('ADMIN_INITIAL_PASSWORD');
    }

    if (!process.env.ADMIN_EMAIL) {
      missing.push('ADMIN_EMAIL');
    }

    if (!process.env.DATABASE_URL) {
      missing.push('DATABASE_URL');
    }

    if (!process.env.APP_BASE_URL) {
      missing.push('APP_BASE_URL');
    } else if (!/^https:\/\//i.test(process.env.APP_BASE_URL)) {
      throw new Error('APP_BASE_URL must use HTTPS in production.');
    }

    if (missing.length) {
      throw new Error(
        `Production startup requires: ${missing.join(', ')}`
      );
    }

    if (SESSION_SECRET.length < 32) {
      throw new Error('SESSION_SECRET must be at least 32 characters in production.');
    }
  }

  await initPostgres();

  await seedAdmin();

  server.listen(
    PORT,
    '0.0.0.0',
    async () => {
      console.log(
        `Homework Genie listening on port ${PORT}`
      );

      if (
        !emailTransporter
      ) {
        console.warn(
          '⚠ SMTP is not configured.'
        );

        return;
      }

      try {
        await emailTransporter.verify();

        console.log(
          '✓ SMTP connection successful'
        );

        console.log(
          `✓ SMTP account: ${process.env.SMTP_USER}`
        );

        console.log(
          `✓ Email sender: ${EMAIL_FROM}`
        );
      } catch (error) {
        console.error(
          '✗ SMTP connection failed:',
          error.message
        );
      }
    }
  );
})();