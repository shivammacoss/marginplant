# Custom Domain + White-Label Branding — Full Implementation Guide

Sab kuch ek jagah — DB schema, backend, frontend, nginx, certbot, aur woh saare bugs jo deploy ke time mile aur kaise fix kiye. Yeh doc padh ke kisi bhi naye project me same feature laga sakte ho.

---

## 1. Feature kya karta hai

Admin (broker) apna khud ka domain (e.g. `stockcafe.live`) platform se connect kar sakta hai. Visitors us domain pe jaate hain, aur unhe broker ka logo + brand name dikhta hai (MarginPlant default ki jagah). HTTPS auto-provision hota hai Let's Encrypt se. Sab kuch admin UI se 4-step wizard ke through.

**Flow:** Admin domain enter → DNS records add (A apex + A www) → backend verify → Let's Encrypt cert issue → nginx reload → site live with SSL.

---

## 2. Architecture overview

```
[Visitor]
    │
    ▼
broker.com (DNS A → PLATFORM_PUBLIC_IP)
    │
    ▼
Origin server :80
    │
    ├── nginx (per-domain server block + SSL cert added by certbot)
    │       │
    │       └── proxy_pass → 127.0.0.1:3000 (user Next.js frontend)
    │
    └── User frontend ──fetch──► api.marginplant.com/branding/by-domain?domain=broker.com
                                        │
                                        ▼
                                 FastAPI backend
                                        │
                                        ▼
                                 Mongo: User (admin row with custom_domain=broker.com, status=READY)
```

---

## 3. Backend pieces

### 3.1 DB schema additions (User model)

Add these optional fields on the **admin** User document. All default `None` — zero impact on existing rows.

| Field | Type | Purpose |
|---|---|---|
| `brand_name` | `str \| None` | "stockcafe" — shown in UI |
| `logo_url` | `str \| None` | `/static/branding/<id>.png` — backend serves via StaticFiles |
| `custom_domain` | `str \| None` | Lowercase apex, e.g. `stockcafe.live` |
| `custom_domain_status` | `str \| None` | `PENDING_DNS` → `DNS_VERIFIED` → `PROVISIONING` → `READY` / `FAILED` |
| `custom_domain_last_error` | `str \| None` | Last failure reason (shown in UI under "Show technical details") |
| `custom_domain_provisioned_at` | `datetime \| None` | When cert was issued |
| `signup_origin` | `str \| None` | On **user** row: `PLATFORM` / `BRANDED_REFERRAL` / `CUSTOM_DOMAIN` |

**Index:** `custom_domain` → unique + sparse (so multiple admins can have NULL but at most one can claim a given domain).

### 3.2 Backend routes

```
GET  /api/v1/branding/by-code/{user_code}      # for ?ref=ADM... links (public)
GET  /api/v1/branding/by-domain?domain=...     # for custom domains (public)
GET  /api/v1/admin/branding/me                 # admin's own branding (auth)
PUT  /api/v1/admin/branding/me                 # update brand_name + logo
POST /api/v1/admin/branding/domain             # set custom_domain → PENDING_DNS
POST /api/v1/admin/branding/domain/verify      # check DNS + kick off provisioning
DEL  /api/v1/admin/branding/domain             # disconnect
GET  /api/v1/user/users/me/branding            # authed user's broker branding
```

### 3.3 DNS verification — **CRITICAL gotcha**

The verify endpoint resolves the admin's apex + www A records and compares against `PLATFORM_PUBLIC_IP`. Use **public DNS resolvers directly**, not the system resolver:

```python
resolver = dns.resolver.Resolver(configure=False)
resolver.nameservers = ["8.8.8.8", "1.1.1.1", "8.8.4.4", "1.0.0.1"]
resolver.lifetime = 5.0
resolver.timeout = 5.0
resolver.cache = None
```

**Why:** `systemd-resolved` / `dnsmasq` aggressively cache `NXDOMAIN`. If you check a domain *before* admin sets DNS records, the cache returns `NXDOMAIN` for 15s–1h even after records are added. `dig` from the same host returns the correct IP (different code path), so this bug looks impossible until you realize the cache layer is different. Public resolvers bypass it.

### 3.4 SSL provisioning (Celery worker)

After DNS verified, a Celery task runs certbot via shell:

```bash
sudo certbot --nginx --non-interactive --agree-tos \
  -m admin@marginplant.com \
  -d broker.com -d www.broker.com
sudo nginx -s reload
```

Backend OS user needs passwordless sudo for these two binaries only:

```bash
sudo tee /etc/sudoers.d/marginplant-branding > /dev/null <<'EOF'
marginplant ALL=(root) NOPASSWD: /usr/bin/certbot, /usr/sbin/nginx
EOF
sudo chmod 0440 /etc/sudoers.d/marginplant-branding
sudo visudo -c
```

### 3.5 nginx config

Catch-all server block for tenant domains proxies to the user frontend on port 3000. Certbot adds the `listen 443 ssl` block + cert paths inline when run with `--nginx`.

```nginx
server {
    listen 80;
    server_name broker.com www.broker.com;   # added by certbot template / helper script
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        # ... standard proxy headers
    }
}
```

### 3.6 Dynamic CORS middleware — **CRITICAL gotcha #2**

Browser on `broker.com` calls `api.marginplant.com/branding/by-domain`. CORS preflight fires. Static `CORSMiddleware` only knows our own origins (`marginplant.com`, etc.), so it rejects `broker.com`. We need a **dynamic** middleware that looks up active tenant domains from DB and allows them.

```python
@app.middleware("http")
async def branding_cors_middleware(request, call_next):
    origin = request.headers.get("origin")
    if not origin or origin in settings.cors_allowed_origins:
        return await call_next(request)
    # Look up active READY-status custom domains (60s in-process cache)
    allowed = await get_active_domains_cached()
    if origin not in allowed:
        return await call_next(request)
    if request.method == "OPTIONS":
        resp = Response(status_code=204)
    else:
        resp = await call_next(request)
    resp.headers["Access-Control-Allow-Origin"] = origin
    resp.headers["Access-Control-Allow-Credentials"] = "true"
    # ... rest of CORS headers
    return resp
```

**Middleware order matters!** Starlette `add_middleware()` PREPENDS — last registered = outermost. The dynamic branding middleware **must be registered AFTER** the static `CORSMiddleware`, otherwise CORSMiddleware intercepts the preflight first and 400s it without ACAO header:

```python
# ✓ Correct order
app.add_middleware(CORSMiddleware, allow_origins=[...])     # inner
app.add_middleware(GZipMiddleware, ...)                     # inner
@app.middleware("http")
async def branding_cors_middleware(...): ...                # OUTERMOST — runs first
```

### 3.7 Feature flag

`BRANDING_ENABLED=false` (default). Everything gated behind this. Endpoints return 503, frontend hides Branding sidebar entry, middleware does nothing. **Zero-second rollback** = flip flag + restart.

---

## 4. Frontend pieces (user-facing site)

### 4.1 `BrandingProvider` (root context)

In `app/providers.tsx`, wrap children with `<BrandingProvider>`. It runs once on mount:

```
if (?ref=CODE in URL)                  → fetchBrandingByCode(code)
else if (host is NOT platform)          → fetchBrandingByDomain(host)   ← custom domain path
else if (logged in)                     → fetchMyBranding(token)        ← may redirect to broker domain
```

Then `applyBrandingChrome(brand)`:
- Sets `document.title` to brand_name
- Swaps `<link rel="icon">` href → tenant logo (mutates in place, NEVER replaces node — Next.js metadata system owns those nodes; replacing crashes React reconciler)
- Repoints `<link rel="manifest">` to `/manifest.webmanifest?u=<user_code>` for PWA install branding

### 4.2 `isPlatformHost()` — **CRITICAL gotcha #3**

```ts
const PLATFORM_HOSTS = new Set([
  "marginplant.com",
  "www.marginplant.com",
  "localhost",
  "127.0.0.1",
]);

function isPlatformHost(host: string): boolean {
  if (PLATFORM_HOSTS.has(host.toLowerCase())) return true;
  return /\.(vercel|netlify|fly)\.(app|dev)$/.test(host);
}
```

**DO NOT** inject `window.location.hostname` into PLATFORM_HOSTS. Looks innocent but every tenant domain self-classifies as platform → `/by-domain` fetch is skipped → branding always falls back to default. This bug ate hours.

### 4.3 Components that consume branding

Every component that shows a logo/name uses `useBranding()`:

```tsx
const { branding } = useBranding();
const customName = (branding?.brand_name ?? "").trim();
const logoSrc = branding?.logo_url ? `${API_URL}${branding.logo_url}` : null;

return logoSrc ? <img src={logoSrc} /> : <DefaultIcon />;
```

Files to update:
- `components/layout/BrandLogo.tsx` (auth pages + dashboard sidebar)
- `components/marketing/MarketingNav.tsx` (public landing pages)
- Any hardcoded "MarginPlant Broker" wordmark (grep the repo)

### 4.4 PWA manifest per tenant

Dynamic route `app/manifest.webmanifest/route.ts` that reads `?u=<user_code>`, looks up branding, returns JSON manifest with broker's `name`, `short_name`, `icons[]`. So "Install app" puts the broker's brand on the OS home screen, not MarginPlant.

---

## 5. Frontend pieces (admin panel)

`app/settings/branding/page.tsx` — 4-step wizard:

1. **Brand identity** — logo upload + brand name (saves to `/api/v1/admin/branding/me`)
2. **Branded links** — copy `marginplant.com/register?ref=ADM...` (shareable on platform host, no custom domain needed)
3. **Connect Custom Domain** (optional):
   - Step 1: Enter domain
   - Step 2: Show DNS records table (A @ → IP, A www → IP) with copy buttons
   - Step 3: Verify & Provision SSL (polls status every 2s — `PENDING_DNS` → `DNS_VERIFIED` → `PROVISIONING` → `READY` / `FAILED`)
   - Step 4: Complete — show live URL with green tick
4. On `FAILED` → show error + Retry button. Use `<details>` for "Show technical details" with the raw DNS lookup output.

---

## 6. Bugs we hit on first production deploy (lessons learned)

| Bug | Symptom | Root cause | Fix |
|---|---|---|---|
| DNS verify stuck on NXDOMAIN | `dig` shows correct IP, backend says NXDOMAIN | systemd-resolved caching negative responses | Use public DNS (8.8.8.8) directly in dnspython, `configure=False` |
| Branding default on tenant domain | `stockcafe.live` shows MarginPlant Broker logo | `window.location.hostname` injected into PLATFORM_HOSTS → tenant self-classified as platform | Remove dynamic hostname injection |
| CORS preflight 400 on tenant domain | Browser: "No 'Access-Control-Allow-Origin' header" | Static CORSMiddleware registered AFTER branding middleware → ran outer → rejected before dynamic lookup | Register dynamic CORS middleware LAST so it's outermost |
| Stale chunk MIME error after rebuild | `ChunkLoadError`, "MIME type 'text/html' not executable" | Browser cached old HTML with old chunk filenames; new build has new hashes | Hard refresh (Ctrl+Shift+R) or use incognito |
| Favicon doesn't change on branded page | Tab icon stays as platform's | Next.js metadata `<link rel="icon">` is React-owned; replacing the node crashed reconciler | Mutate `href` attribute in place + append one extra branding-owned `<link>` with our own id |
| App error after manifest swap | "Cannot read properties of null (reading 'removeChild')" | Used `cloneNode`/`replaceWith` on React-managed icon link | Never replace React-managed nodes; only setAttribute |

---

## 7. Replication checklist (new project)

Use this list to port the feature into a fresh repo.

### Backend
- [ ] Add 7 optional fields to User model (see §3.1) + sparse-unique index on `custom_domain`
- [ ] `BRANDING_ENABLED` env flag (default false) + `PLATFORM_PUBLIC_IP` env
- [ ] `app/services/branding_service.py` with: `to_branding_payload()`, `find_admin_by_user_code()`, `find_admin_by_domain()`, `check_dns_a_record()`, `all_active_custom_domains()`, `resolve_dns_preview()`
- [ ] **dnspython public resolvers** (8.8.8.8, 1.1.1.1) — never system resolver
- [ ] `app/api/v1/branding.py` with public + admin routes (see §3.2)
- [ ] Celery task that runs certbot + nginx reload (passwordless sudo via `/etc/sudoers.d/`)
- [ ] **Dynamic CORS middleware registered LAST** in `app/main.py` (see §3.6)
- [ ] StaticFiles mount for `/static/branding/` (logo uploads)
- [ ] `pip install dnspython==2.6.1`

### Server (one-time)
- [ ] `sudo apt install certbot python3-certbot-nginx`
- [ ] Passwordless sudo for backend user → certbot + nginx
- [ ] nginx catch-all server block proxying to user frontend port
- [ ] Public IP reachable on :80 (Cloudflare not proxying tenant domains, OR Cloudflare in Full strict mode)
- [ ] Celery worker running as systemd unit

### Frontend (user site)
- [ ] `lib/branding-context.tsx` with `BrandingProvider` + `useBranding()` hook
- [ ] `PLATFORM_HOSTS` is a STATIC list — **never inject `window.location.hostname`**
- [ ] `applyBrandingChrome()` mutates `<link rel="icon">` href in place, appends one extra branding-owned `<link>` with id
- [ ] Manifest <link> repointed to `/manifest.webmanifest?u=<user_code>`
- [ ] `app/manifest.webmanifest/route.ts` returns dynamic manifest per `?u=` param
- [ ] Every brand-mark component uses `useBranding()` — grep the repo for hardcoded brand strings
- [ ] `NEXT_PUBLIC_API_URL` env points to backend origin (CORS request goes here)

### Frontend (admin panel)
- [ ] `/settings/branding` 4-step wizard
- [ ] DNS records table with copy buttons (reads `NEXT_PUBLIC_PLATFORM_PUBLIC_IP`)
- [ ] Polling: every 2s GET `/admin/branding/me` until status terminal (`READY` / `FAILED`)
- [ ] "Show technical details" `<details>` block with raw DNS lookup string
- [ ] Retry button on `FAILED` → POST `/admin/branding/domain/verify` again

### Smoke test (in this exact order)
1. Admin uploads logo + sets brand name → save → `https://platform.com/register?ref=ADM123` shows branding ✓
2. Admin enters custom domain → table shows DNS records ✓
3. Add A records at registrar → propagation ~1-5 min
4. Click Verify → status transitions `PENDING_DNS` → `DNS_VERIFIED` → `PROVISIONING` → `READY` (60-90s total) ✓
5. Open `https://broker.com/login` → branded UI + SSL lock ✓
6. CORS test: `curl -I -X OPTIONS -H "Origin: https://broker.com" "https://api.platform.com/branding/by-domain?domain=broker.com"` → must return `access-control-allow-origin: https://broker.com` ✓
7. Existing 10k users still log in on platform.com — no redirect, no regression ✓

---

## 8. Operational commands cheat-sheet

```bash
# Check live cert
sudo certbot certificates

# Manually renew a tenant cert
sudo certbot renew --cert-name broker.com

# Force re-verify a stuck domain (from backend shell)
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://api.platform.com/api/v1/admin/branding/domain/verify

# Flush server DNS cache (after admin updates registrar)
sudo resolvectl flush-caches
sudo systemctl restart backend.service worker.service

# Check what the backend sees for a domain
curl "https://api.platform.com/api/v1/branding/by-domain?domain=broker.com"

# Test CORS preflight
curl -sI -X OPTIONS \
  -H "Origin: https://broker.com" \
  -H "Access-Control-Request-Method: GET" \
  "https://api.platform.com/api/v1/branding/by-domain?domain=broker.com" \
  | grep -i access-control

# Tail branding-related logs
sudo journalctl -u backend.service -u worker.service -f | grep -iE 'brand|domain|certbot|provision'
```

---

## 9. Files touched in this codebase (reference list)

**Backend:**
- `backend/app/models/user.py` — schema fields
- `backend/app/api/v1/branding.py` — public + admin routes
- `backend/app/services/branding_service.py` — DNS check, domain lookup, payload shaping
- `backend/app/workers/tasks/branding.py` — certbot provisioning task
- `backend/app/main.py` — middleware order (see §3.6)
- `backend/app/core/config.py` — `BRANDING_ENABLED`, `PLATFORM_PUBLIC_IP`

**Frontend user:**
- `frontend-user/lib/branding-context.tsx` — provider + chrome swap
- `frontend-user/app/providers.tsx` — wrap with BrandingProvider
- `frontend-user/components/layout/BrandLogo.tsx`
- `frontend-user/components/marketing/MarketingNav.tsx`
- `frontend-user/app/manifest.webmanifest/route.ts`

**Frontend admin:**
- `frontend-admin/app/settings/branding/page.tsx` — 4-step wizard

**Ops:**
- `deploy/nginx/marginplant.conf` — catch-all server block
- `/etc/sudoers.d/marginplant-branding` — passwordless certbot + nginx
- `backend/DEPLOY_BRANDING.md` — phased rollout notes

---

**Rule of thumb:** Har step ko independently rollback-able rakhna. Feature flag = panic button. Bugs jo hume mile sab DNS / cache / middleware-order related the — production me yeh teeno cheezein **always** verify karna deploy se pehle.
