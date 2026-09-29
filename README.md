# Homework Genie — Production-ready Node.js + PostgreSQL

This package is a production-ready build of Homework Genie. It contains the student site, admin dashboard, Node.js backend, PostgreSQL-backed application state, persistent private file storage, authentication, quote/invoice workflow, password reset, WhatsApp contact, email notifications, and integration tests.

The interface has been refreshed around the supplied Homework Genie logo. The public pages use a flat plum, cream and gold palette, and interface symbols are rendered as icons rather than emoji. The wording was also tightened so it reads like a small service business rather than a generic marketing template.

## 1. Requirements

- Windows/macOS/Linux
- PyCharm Community or Professional
- Node.js 18+ (Node.js 20+ recommended)
- A modern browser (Chrome/Edge/Firefox)
- PostgreSQL is required for production.
- Node.js 20+ is recommended.
- Run `npm install` before local development.

Check Node from PyCharm's Terminal:

```bash
node --version
npm --version
```

## 2. Project structure

```text
homework-genie/
├── server.js
├── package.json
├── .env.example
├── README.md
├── public/
│   ├── index.html
│   └── admin.html
├── data/
│   ├── db.json              # created automatically
│   └── files/               # private uploaded files
└── tests/
    └── api.test.js
```

## 3. First-time PyCharm setup

1. Extract this ZIP into a folder.
2. Open that folder in PyCharm.
3. Open **Terminal** inside PyCharm.
4. Copy `.env.example` to `.env`.
5. Change `SESSION_SECRET` to a long random value (32+ characters; 48–64+ is better).
6. Change `ADMIN_INITIAL_PASSWORD` to your own strong password.
7. Save `.env`.

Example `.env`:

```env
PORT=3000
NODE_ENV=development
SESSION_SECRET=put-a-long-random-secret-here
ADMIN_EMAIL=hwgenie@proton.me
ADMIN_INITIAL_PASSWORD=YourStrongAdminPassword2026!
APP_BASE_URL=http://localhost:3000

# Production/PostgreSQL
DATABASE_URL=
DATABASE_SSL=true

# SMTP
SMTP_HOST=
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=
SMTP_PASSWORD=
EMAIL_FROM=Homework Genie <hwgenie@proton.me>
ADMIN_NOTIFICATION_EMAIL=hwgenie@proton.me
```

**Do not commit `.env` to GitHub.** Add it to `.gitignore` if you use Git.

The server automatically creates the admin user the first time it starts. The admin password is stored as a salted PBKDF2 hash in `data/db.json`; the plaintext password is not stored.

## 4. Run in PyCharm

### Option A — PyCharm Terminal

Run:

```bash
npm start
```

Then open:

- Public website: `http://localhost:3000/`
- Admin dashboard: `http://localhost:3000/admin.html`
- Health check: `http://localhost:3000/api/health`

### Option B — PyCharm Run Configuration

1. Go to **Run → Edit Configurations**.
2. Add a **Node.js** configuration.
3. JavaScript file: `server.js`.
4. Working directory: the project root.
5. Click **Run**.

## 5. Admin login

Use the values from `.env`:

```text
Email:    your ADMIN_EMAIL value
Password: your ADMIN_INITIAL_PASSWORD value
```

Use the password you set in `.env`.

Change it before any real deployment.

The login uses an **HttpOnly, SameSite session cookie**, not a password stored in frontend JavaScript. Passwords use PBKDF2-HMAC-SHA256 with a per-user salt. Admin login is rate-limited and protected by same-origin checks on state-changing requests.

## 6. What to test manually

### Test A — Guest quote request

1. Open `/`.
2. Click **Request a Quote — No account required**.
3. Fill in the required fields.
4. Attach a PDF/DOCX/etc. under 20 MB.
5. Submit.
6. Open `/admin.html` in another tab.
7. Log in.
8. Open **Quote Requests**.
9. Confirm the request appears.
10. Open it and confirm the assignment details and file are visible.
11. Click the file to verify the protected download.
12. Enter a price and create the quote.

### Test B — Student account

1. Create a Student account using the site's sign-up form.
2. Confirm you land in the student dashboard.
3. Submit an assignment.
4. Confirm it appears in the admin dashboard.
5. As admin, create a quote for the assignment.
6. Return to the student dashboard.
7. Open **My Quotes**.
8. Accept the quote.
9. Confirm an invoice appears under **My Invoices**.

### Test C — Admin payment workflow

1. In Admin → Invoices, find the invoice.
2. Use **Mark paid** for a local/manual payment test.
3. Confirm the invoice changes to `paid`.
4. Open Admin → Payments and confirm the payment record exists.

This manual payment control is only a testing/operations feature. A real PayPal checkout must be connected before live payments are accepted.

### Test D — Authentication

Verify:

- Wrong student password is rejected.
- Wrong admin password is rejected.
- Student sessions cannot open `/api/admin/dashboard`.
- Admin sessions cannot use student-only endpoints.
- Logging out clears the session cookie.
- Uploaded files cannot be downloaded without authentication.
- A student cannot download another student's file.

## 7. Automated integration test

From the PyCharm Terminal:

```bash
npm test
```

The test starts an isolated temporary server/database and checks:

- Admin creation and login
- Admin session authentication
- Student registration/login
- Guest quote request
- File upload/storage
- Student assignment submission
- Admin dashboard visibility
- Quote creation
- Student quote acceptance
- Invoice creation
- Manual payment recording
- Protected file download
- Student/admin authorization boundaries
- Password reset
- One-time reset-token consumption
- Admin password change
- Re-login with the new admin password
- Rejection of an incorrect admin password

Expected result:

```text
ALL API INTEGRATION TESTS PASSED
```

## 8. Changing the admin password

The backend exposes a protected admin password-change endpoint:

```text
POST /api/admin/password
```

Body:

```json
{
  "currentPassword": "old-password",
  "newPassword": "new-strong-password"
}
```

The endpoint requires an authenticated admin session. After changing the password, the current session is cleared and the admin must log in again.

For now, the easiest local method is to use the browser developer tools or a REST client. A dedicated Settings screen can be added to the admin dashboard later if desired.

## 9. JSON database notes

The backend intentionally uses JSON for this development stage.

Data is stored in:

```text
data/db.json
```

Writes are serialized and performed atomically through a temporary file + rename operation. This is safer than directly overwriting the database file, but JSON is still not the right long-term database for a large production system.

When Homework Genie grows, the data layer can be moved to PostgreSQL without redesigning the frontend workflow.

## 10. File security

Uploaded files are stored outside the public web directory:

```text
data/files/
```

The browser cannot directly request `/data/files/...`.

Downloads go through:

```text
GET /api/files/:fileId
```

The backend checks authentication and ownership before serving a file.

Allowed file types:

```text
PDF, DOC, DOCX, PPT, PPTX, XLS, XLSX, TXT, ZIP
```

Maximum individual file size: **20 MB**.

Maximum JSON request body: **35 MB**.

## 11. Security implemented in this build

- Passwords are hashed using PBKDF2-HMAC-SHA256 with unique salts.
- Authentication uses HttpOnly SameSite cookies.
- Production cookies receive the `Secure` flag.
- Login and registration endpoints are rate-limited.
- Password reset tokens are random, hashed in storage, expire after 30 minutes, and are single-use.
- State-changing requests enforce same-origin checks.
- Admin/student roles are checked server-side.
- Security response headers are set.
- User passwords are never returned by the API.
- Uploaded files are stored privately.
- File paths are generated with UUIDs rather than user-controlled filenames.
- Original filenames are sanitized before download.
- API inputs have size/length/type validation.
- JSON writes are serialized and atomic.

## 12. Things you still need to add manually

### Required for local testing

Create `.env` and set:

```env
SESSION_SECRET=...
ADMIN_INITIAL_PASSWORD=...
```

### Required before production

You will still need to configure:

1. **HTTPS** — use a reverse proxy such as Nginx/Caddy or a hosting platform that provides TLS.
2. **Real email provider** — for quote emails, password reset emails, status updates and notifications.
3. **Real PayPal credentials** — client ID/secret and server-side payment verification.
4. **Production file storage** — preferably private object storage instead of local disk.
5. **Backups** — automated encrypted backups of the JSON data and private files.
6. **Domain/DNS** — your Homework Genie domain.
7. **Production secrets** — unique session secret and strong admin password.
8. **Database migration** — move from JSON to PostgreSQL when traffic/concurrency warrants it.
9. **Google OAuth** — the Google buttons are intentionally disabled until a proper server-side OAuth verification flow is configured.

## 13. Important production warning

Do not deploy the development server directly to the public internet without HTTPS, a production secret, backups, protected file storage, monitoring and a production-grade process/reverse proxy.

The JSON backend is intended to let us complete and test the application workflow first. PostgreSQL can be introduced later behind the same API/data-service boundary.

## Production deployment on Render

This version is prepared for an initial Render deployment while retaining the current JSON database and local file-storage architecture. Render's normal filesystem is ephemeral, so this storage should be treated as temporary until it is migrated to persistent storage.

### Render settings

- Service: **Web Service**
- Runtime: **Node**
- Build command: `npm install`
- Start command: `npm start`
- Health check path: `/api/health`

### Required production environment variables

```text
NODE_ENV=production
APP_BASE_URL=https://YOUR-RENDER-DOMAIN.onrender.com
SESSION_SECRET=<at least 32 random characters>
ADMIN_EMAIL=<your-admin-email>
ADMIN_INITIAL_PASSWORD=<your strong admin password>
```

Do not commit real secrets or a production `.env` file. The deploy package intentionally does not include the development `data/db.json`; the application creates the initial database and seeds the admin account from the production environment variables.

SMTP variables are needed if production email delivery/password-reset emails are required.


## 8. Production deployment on Render

This repository includes `render.yaml` and `schema.sql`.

1. Push the project to GitHub.
2. In Render choose **New → Blueprint** and select the repository.
3. Render creates the Homework Genie web service and PostgreSQL database.
4. Set the secret values requested by the Blueprint:
   - `ADMIN_EMAIL`
   - `ADMIN_INITIAL_PASSWORD`
   - `APP_BASE_URL`
   - `SMTP_HOST`
   - `SMTP_USER`
   - `SMTP_PASSWORD`
5. Keep `DATABASE_URL` supplied automatically by Render.
6. Deploy and test `/api/health`, registration/login, password reset, quote submission, assignment upload, admin dashboard, and email delivery.
7. Add your custom domain only after the Render URL has passed the tests.

Uploaded assignment files are stored under `HG_DATA_DIR` and the Render Blueprint mounts `/var/data` as a persistent disk.

Production startup requires `DATABASE_URL`, `SESSION_SECRET`, `ADMIN_INITIAL_PASSWORD`, `ADMIN_EMAIL`, and an HTTPS `APP_BASE_URL`.

## 9. Contact

- WhatsApp: +1 917 640 4768
- Email: hwgenie@proton.me

The landing page and student dashboard include clickable contact buttons.
