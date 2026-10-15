# Deploying LoveFox to Hostinger (Business/shared hosting, hPanel)

You're on Hostinger's shared/Business plan, not a VPS - this doc is written
for that specifically. Two things about this app don't fit shared hosting
out of the box, and both are handled below:

1. **Postgres.** Hostinger shared/Business plans only give you MySQL
   databases in hPanel. This app's Prisma schema is written for Postgres, so
   you'll point `DATABASE_URL` at a free external Postgres instead of a
   Hostinger-hosted one. No code changes needed - Prisma just needs a
   reachable connection string.
2. **Two apps, one plan.** The backend (NestJS, needs a running Node
   process) and the frontend (Angular, compiles to static files) are
   deployed completely differently. The frontend does **not** need a Node.js
   app slot at all - it's just files in `public_html`.

## Architecture on Hostinger

```
lovefox.example          -> public_html/            (Angular static build, Apache)
api.lovefox.example      -> hPanel "Node.js App"     (NestJS, Passenger-managed)
Postgres                 -> external (Neon/Supabase/Aiven free tier)
```

## 1. Get a Postgres database

Pick one (all have a free tier, all give you a ready `postgresql://...`
connection string with `sslmode=require`):

- **Neon** (neon.tech) - easiest, serverless Postgres, generous free tier.
- **Supabase** (supabase.com) - also gives you a dashboard/table editor.
- **Aiven** - if you want something closer to a traditional managed DB.

Create the database, copy the connection string, and keep it for step 3.

## 2. DNS: create the API subdomain

In hPanel → **Domains → DNS / Subdomains**, create `api.lovefox.example`
pointing at your Hostinger hosting (hPanel does this for you when you create
the subdomain there rather than in an external DNS panel). This is where the
backend will live; the root domain stays the Angular frontend.

## 3. Deploy the backend

In hPanel → **Advanced → Node.js**, create a new application:

| Setting | Value |
|---|---|
| Node.js version | 20.x |
| Application mode | Production |
| Application root | e.g. `lovefox-backend` (a folder outside `public_html`) |
| Application URL | `api.lovefox.example` |
| Application startup file | `dist/src/main.js` |

Then:

1. **Upload the code.** Either `git clone` your repo over SSH (Business
   plans include SSH access - hPanel → Advanced → SSH Access) into the
   application root, or zip `datingAppBackEnd/` (minus `node_modules`,
   `dist`, `uploads`) and upload it via File Manager.
2. From hPanel's Node.js app screen, use **Run NPM Install**, then open the
   app's shell (or SSH in) and run:
   ```
   npm run build
   npx prisma migrate deploy
   ```
3. **Environment variables** - set these in the Node.js app's *Environment
   variables* section in hPanel (don't rely on a committed `.env`). Real,
   ready-to-use values (secrets already generated) are in
   `datingAppBackEnd/.env.hostinger` - open that file and copy them in.
   Summary of what each one is:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | your Neon/Supabase connection string from step 1 |
   | `PORT` | `8000` (hPanel's Passenger layer overrides this at runtime, harmless either way) |
   | `NODE_ENV` | `production` |
   | `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | generated for you, see `.env.hostinger` |
   | `JWT_ACCESS_EXPIRES_IN` / `JWT_REFRESH_EXPIRES_IN` | `15m` / `7d` |
   | `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | generated for you, see `.env.hostinger` |
   | `FRONTEND_URL` | `https://lovefox.example` (your real domain, exact scheme+host, no trailing slash) |
   | `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | use the free mailbox that ships with your Hostinger plan (hPanel → Emails), or leave blank to just log emails instead of sending them |

4. **Start/restart** the app from hPanel.
5. Sanity check: visit `https://api.lovefox.example/api/docs` - you should
   see the Swagger UI.

### Uploaded photos (`/uploads`)

Profile photos, chat attachments, and verification selfies are written to
`./uploads` next to the running app (see `main.ts`). On Hostinger's
Node.js hosting these files persist on disk across restarts, but **will be
wiped if you ever re-upload/replace the whole application folder** (e.g. a
fresh `git clone` over the top of it). Two options:
- Fine for now: just don't delete/replace the app folder wholesale - only
  `git pull` or overwrite the `dist` folder on future deploys, leave
  `uploads/` alone.
- More robust long-term: move to S3-compatible object storage (Cloudflare
  R2, Backblaze B2). Not done here since it's a real code change (multer
  storage engine + serving URLs) - say the word if you want that added.

### Chat & voice calls (Socket.IO)

Fixed as part of this pass: `chat.gateway.ts`'s CORS was hardcoded to only
allow `localhost`/LAN origins, which would have **silently broken chat and
call signaling in any real production deployment** (it now mirrors
`main.ts` and allows `FRONTEND_URL` in production, same as everywhere else).

One Hostinger-specific caveat: shared hosting's reverse proxy (Passenger)
doesn't always reliably upgrade connections to a raw WebSocket. Socket.IO
already handles this gracefully by falling back to HTTP long-polling
automatically - chat and call signaling will still work, just with slightly
higher latency on that fallback. If real-time features feel sluggish, that's
the reason; a Hostinger VPS (or Railway/Render for just the backend) would
give a full WebSocket upgrade instead of relying on the fallback.

## 4. Deploy the frontend

The Angular app is renamed and design-refreshed already (see below) and
builds to `dist/lovefox-front/browser`. From `datingAppFrontEnd/`:

```bash
# First, point src/environments/environment.prod.ts's apiUrl at your real
# backend subdomain (currently a placeholder: https://api.lovefox.example).
npm run build
```

Upload everything inside `dist/lovefox-front/browser/` (including the
`.htaccess` file - it's what makes Angular's client-side routing work on
Apache; without it, refreshing any page but `/` 404s) to `public_html/` via
File Manager or FTP/SFTP.

## 5. SSL

hPanel → **Security → SSL** - issue a free SSL certificate for both
`lovefox.example` and `api.lovefox.example`. Do this after both are
pointed at Hostinger and resolving, then force HTTPS redirects for both.

## 6. Post-deploy checklist

- [ ] `https://lovefox.example` loads the app, refreshing on `/dashboard` etc. doesn't 404
- [ ] `https://api.lovefox.example/api/docs` loads Swagger
- [ ] Register a test account → welcome email arrives (or check logs if SMTP is blank)
- [ ] Log in from two browsers, send a chat message, confirm it arrives live
- [ ] Try a voice call between two test accounts
- [ ] Upload a profile photo, refresh, confirm it still loads

## If this outgrows shared hosting

The honest limits of this plan: one Node.js app process (Passenger will
restart it on crash, but there's no real scaling), no persistent background
workers, and the WebSocket-upgrade caveat above. If usage grows, Hostinger's
**VPS (KVM)** plans give you full Docker support, which is what
`docker-compose.yml`/the backend `Dockerfile` in this repo were already set
up for - that path needs no application changes, just a different deploy
target.
