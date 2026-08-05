# Jose Industries App

Full-stack app: Express + TypeScript API, React (Vite + TypeScript) frontend, MySQL database.
The backend serves both the `/api/*` routes and the built frontend from a single Node.js
process — this matches Hostinger's Web Apps hosting, which runs one Node.js application.

## Structure

```
.
├── src/                     # Express + TypeScript backend source
│   ├── index.ts             # App entry point (serves API + built client)
│   ├── config/db.ts         # MySQL connection pool
│   ├── db/schema.sql        # Table definitions
│   ├── db/migrate.ts        # Runs schema.sql against DB_* from .env
│   ├── db/seedAdmin.ts      # Bootstraps the first super_admin user
│   ├── middleware/auth.ts   # requireAuth / requireRole (JWT cookie)
│   ├── services/numbering.ts       # Atomic per-company, per-type, per-FY document numbers
│   ├── services/pdf/quotationPdf.ts # Multi-page aware: repeating header, non-splitting footer
│   ├── utils/gst.ts         # CGST/SGST vs IGST split, HSN grouping
│   ├── utils/numberToWords.ts      # Indian-numbering amount-in-words
│   ├── routes/auth.ts       # /api/auth: login, logout, me
│   ├── routes/users.ts      # /api/users: user management CRUD (RBAC)
│   ├── routes/companies.ts  # /api/companies: the GST-registered entities
│   ├── routes/customers.ts  # /api/customers
│   ├── routes/items.ts      # /api/items: product/service catalog
│   └── routes/quotations.ts # /api/quotations: CRUD + PDF export
├── client/                   # React + Vite + TypeScript frontend (Ant Design)
│   └── src/
│       ├── context/AuthContext.tsx
│       ├── layouts/AppLayout.tsx   # Sidebar (desktop) / Drawer (mobile)
│       └── pages/                 # LoginPage, HomePage, UsersPage, CompaniesPage,
│                                   # CustomersPage, ItemsPage, QuotationsPage
├── dist/                     # Compiled backend (generated, gitignored)
├── public/                   # Built frontend assets (generated, gitignored)
├── .env.example              # Copy to .env for local dev
└── package.json              # Root scripts drive both client and server
```

## User roles

Three roles: `super_admin`, `admin`, `staff`.
- `super_admin` can manage anyone, including other super admins, and is the only role that can delete users.
- `admin` can manage `admin` and `staff` accounts, but cannot create, edit, or view a `super_admin` account.
- `staff` has no access to User Management.
- The app always keeps at least one active `super_admin` — the last one can't be demoted, deactivated, or deleted.

## Sales documents (Phase 1: Quotations)

Replaces the Excel-based quotation/invoice process, whose shared-file editing let two people
claim the same "next number" at once. Numbers are now issued by `getNextDocNumber()`
(`src/services/numbering.ts`), which uses MySQL's `INSERT ... ON DUPLICATE KEY UPDATE
LAST_INSERT_ID(expr)` trick on a single connection — the row lock that upsert takes makes
concurrent requests serialize, so two people creating a quotation at the same instant can
never receive the same number. Format: `QTN/JE/25-26/0001` (doc-type / company code /
financial year / sequence), resetting every financial year (Apr–Mar) per standard GST
practice. Each company has its own independent counter.

**Two companies**: the business operates as two separate GST-registered entities, Jose
Enterprises (`JE`) and Jose Industries (`JI`), each with its own GSTIN, address, bank details,
and invoice series — seeded via `npm run db:seed-companies`, editable from the Companies page
(edit requires `admin`/`super_admin`). Every document picks one at creation time.

The document field set matches the company's existing Tally-style Tax Invoice template
(consignee/ship-to, transport & dispatch references, buyer's order no, GST tax breakup by
HSN, bank details, amount-in-words, dual signature blocks) so later phases (Proforma
Invoice, Delivery Challan, Tax Invoice, Receipts) need no further schema changes — just reuse
of the same `documents` / `document_items` tables. CGST/SGST vs IGST is derived automatically
by comparing the issuing company's state to the customer's state, never chosen manually.

PDFs (`src/services/pdf/quotationPdf.ts`) are multi-page aware: the company header repeats
(full on page 1, condensed on continuation pages) and the closing block (totals, tax
breakup, bank details, signatures) is measured up front and pushed onto a fresh page as a
whole if it wouldn't otherwise fit, so it's never split across a page boundary.

Phase 1 covers Companies, Customers, an Items catalog, and Quotations (create/edit/list/PDF
export). Staff and above can create Quotations/Customers/Items; deleting any of them requires
`admin`/`super_admin`.

## Local development

Requirements: Node.js 18+, a MySQL server reachable from your machine (local, or a remote one
with your IP allowed via a remote-connection rule).

```bash
cp .env.example .env      # fill in DB_*, JWT_SECRET
npm install
npm run db:migrate        # creates all tables
npm run db:seed-admin     # creates the first super_admin (prints its password once)
npm run db:seed-companies # seeds Jose Enterprises + Jose Industries
npm run dev
```

`npm run dev` runs the API on port 3000 and the Vite dev server (with hot reload) on 5173,
proxying `/api` requests to the backend. Open http://localhost:5173.

## Production build

```bash
npm run build   # builds client into ../public, then compiles server into dist/
npm start        # node dist/index.js — serves API + client on $PORT (default 3000)
```

`npm install` triggers this build automatically via the `postinstall` script, which is what
makes the one-command Hostinger deploy below work.

## Deploying to Hostinger (Web Apps / Node.js)

1. **Push this repo to GitHub/GitLab** (or your git host of choice).
2. In **hPanel → Websites → [your site] → Advanced → Node.js** (or **Web Apps**), create a new
   Node.js application:
   - **Node.js version**: 18 or newer (see `.nvmrc`)
   - **Application root**: the folder you deploy into (repo root)
   - **Application startup file**: `dist/index.js`
3. **Connect Git**: under the same section (or **Git** in hPanel), point it at this repository
   and branch, then deploy/pull.
4. Set environment variables in the Node.js app's **Environment variables** panel (mirror
   `.env.example`): `PORT` (Hostinger usually sets this for you), `DB_HOST` (use `127.0.0.1`,
   **not** `localhost` — Node's MySQL driver resolves `localhost` over the network rather than
   a Unix socket, and often picks the IPv6 loopback `::1` first, which the DB user's grant
   doesn't cover), `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `JWT_SECRET`.
5. Create a MySQL database in **hPanel → Databases → MySQL Databases** and use its
   host/user/password/name for the variables above.
6. Click **NPM Install** in the Node.js app panel — this runs `npm install`, which triggers
   `postinstall` → `npm run build`, producing `dist/` and `public/`.
7. Run the migration and seed data (via hPanel's terminal/SSH, or a one-off script):
   `npm run db:migrate && npm run db:seed-admin && npm run db:seed-companies`.
8. **Restart** the application. Visit your domain — it should serve the React app, with
   `/api/health` and `/api/health/db` available for a quick check.

Whenever you push new commits, re-pull in hPanel (or re-run the Git deploy), then click
**NPM Install** and **Restart** again to rebuild and pick up the changes. If the commit added
or changed tables in `src/db/schema.sql`, also re-run `npm run db:migrate` (safe to run
repeatedly — every statement is `CREATE TABLE IF NOT EXISTS`).
