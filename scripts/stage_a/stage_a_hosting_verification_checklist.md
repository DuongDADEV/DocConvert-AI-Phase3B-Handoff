# Stage A Hosting & Deployment Platform Verification Checklist

**Project**: DocConvert AI  
**Release ID**: `stage-a-3b-bridge-20261004-03`  
**Purpose**: Verify hosting provider dashboard settings before deploying Stage A to guarantee no automatic DB migrations will run during deployment.

---

### 1. Hosting Platform Identification
- [x] Record the actual production hosting platform for backend services:
  - Platform Name: `Railway`
  - Workspace: `DuongAIOS's Projects`
  - Project: `zealous-friendship` (Note: Project name is zealous-friendship, NOT DocConvert-AI)
  - Environment: `production`
  - Backend Service Name: `DocConvert-AI`
  - Evidence in repository: `vercel.json` configures frontend SPA routing only; backend hosting is Railway.

---

### 2. Build Command Verification
- [ ] Inspect the hosting service **Build Command** setting in the dashboard.
  - Expected: `npm run build` or `vite build && esbuild server.ts ...`
  - Actual Dashboard Value: `________________________`
  - Verified no migration command (`supabase db push`, `apply_migration`, `psql`) is appended: **YES / NO**

---

### 3. Start Command Verification
- [ ] Inspect the hosting service **Start Command** setting.
  - Expected: `npm start` or `node dist/server.cjs`
  - Actual Dashboard Value: `________________________`
  - Verified no pre-start migration wrapper exists: **YES / NO**

---

### 4. Pre-Deploy Command Verification
- [ ] Check if the hosting platform has a **Pre-Deploy Command** or **Release Phase** configured (e.g. Heroku `release:`, Render `preDeployCommand`, Railway pre-deploy).
  - Is Pre-Deploy configured: **YES / NO**
  - If YES, command content: `________________________`
  - Verified no SQL execution or migration step: **YES / NO**

---

### 5. Post-Deploy / Release Command Verification
- [ ] Check if any **Post-Deploy Webhook** or **Deploy Hook** triggers database migrations.
  - Are post-deploy hooks configured: **YES / NO**
  - Verified no automatic schema migration: **YES / NO**

---

### 6. DB Migration Hooks & CLI Verification
- [ ] Verify that none of the following migration tools are configured as automatic deployment steps:
  - [ ] `supabase db push`
  - [ ] `supabase migration up`
  - [ ] `psql -f ...`
  - [ ] `prisma migrate deploy`
  - [ ] `sequelize db:migrate`
  - [ ] Custom migration scripts (`apply_phase*.ts`, etc.)

---

### 7. Environment Variables Configuration
- [ ] Initial deployment environment variables set:
  - `PORT`: (configured, e.g. 3000 / 8080)
  - `NODE_ENV`: `production`
  - `SUPABASE_URL`: (verified valid)
  - `SUPABASE_SERVICE_ROLE_KEY`: (verified valid)
  - `JWT_SECRET`: (verified valid)
  - `PROCESSING_MAINTENANCE_MODE`: `false` (MUST be `false` during initial health check)

---

### 8. PROCESSING_MAINTENANCE_MODE Activation Flow
- [ ] Understand and prepare maintenance toggle:
  1. Boot Stage A with `PROCESSING_MAINTENANCE_MODE=false`.
  2. Health-check app (login, dashboard, upload, preflight).
  3. Toggle `PROCESSING_MAINTENANCE_MODE=true` in hosting dashboard.
  4. Trigger rolling restart/reload across all instances.
  5. Verify `POST /api/documents/:id/process` returns **HTTP 503**.
  6. Verify `POST /api/documents/:id/ocr` returns **HTTP 503**.

---

### 9. Multi-Instance / Fleet Behavior
- [ ] Check instance count:
  - Number of backend instances in fleet: `______`
  - If multiple instances: confirm rolling restart updates ALL instances to release `stage-a-3b-bridge-20261004-03`.
  - Prohibit mixed fleet (no old instance without bridge allowed): **CONFIRMED**

---

### 10. Operator Confirmation & Sign-Off
- [ ] Operator sign-off on hosting migration safety:
  - **REPOSITORY_AUTO_MIGRATION**: `NO` (Source-verified)
  - **HOSTING_PLATFORM_AUTO_MIGRATION**: `[ ] NO  /  [ ] YES  /  [ ] NOT_VERIFIED`
  - Checked by (Name / Role): `________________________`
  - Date: `________________________`
