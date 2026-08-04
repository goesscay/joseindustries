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
│   ├── routes/auth.ts       # /api/auth: login, logout, me
│   └── routes/users.ts      # /api/users: user management CRUD (RBAC)
├── client/                   # React + Vite + TypeScript frontend (Ant Design)
│   └── src/
│       ├── context/AuthContext.tsx
│       ├── layouts/AppLayout.tsx   # Sidebar (desktop) / Drawer (mobile)
│       └── pages/                 # LoginPage, HomePage, UsersPage
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

## Local development

Requirements: Node.js 18+, a MySQL server reachable from your machine (local, or a remote one
with your IP allowed via a remote-connection rule).

```bash
cp .env.example .env      # fill in DB_*, JWT_SECRET
npm install
npm run db:migrate        # creates the users table
npm run db:seed-admin     # creates the first super_admin (prints its password once)
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
7. Run the migration and seed the first super admin (via hPanel's terminal/SSH, or a one-off
   script): `npm run db:migrate && npm run db:seed-admin`.
8. **Restart** the application. Visit your domain — it should serve the React app, with
   `/api/health` and `/api/health/db` available for a quick check.

Whenever you push new commits, re-pull in hPanel (or re-run the Git deploy), then click
**NPM Install** and **Restart** again to rebuild and pick up the changes.
