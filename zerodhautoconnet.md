# Zerodha Auto-Connect — Implementation Plan

> **Goal:** Daily 7:00 AM IST par Zerodha Kite Connect access_token automatically refresh ho. Admin ko manually `kite.zerodha.com/connect/login` pe jaake Authy 6-digit code daalna na pade. Market open hone se pehle live ticks ready ho jayein.

---

## 1. Background — kya problem solve kar rahe hain

**Current state:**
- Zerodha Kite Connect access_token daily 7:00 AM IST par expire hota hai (Kite-enforced).
- Admin manually `/admin/zerodha` page se "Login with Kite" button click karta hai.
- OAuth redirect → Kite login screen → username + password + Authy 6-digit TOTP → callback → new access_token DB mein save.
- Total time: ~30 seconds manual effort, every weekday.

**Problem:**
- Admin late uthe ya phone band ho → market open, koi data nahi → users complain "price nahi aa raha" → trust gone.
- 5000+ users wale platform mein zero tolerance for this.

**Goal of this project:**
- Daily 7:00 AM IST par backend automatically Kite mein login kare, fresh access_token store kare, WS reconnect ho jaye.
- Zero human intervention required.
- Failure case mein admin ko immediate alert (existing notification + WhatsApp).

---

## 2. Reality check — Kite Connect API limitations

**Kite Connect standard API mein `refresh_token` SUPPORT NAHI hai.**

Iska matlab har din fresh OAuth flow chahiye:
1. Username + Password
2. TOTP (6-digit code from Authy app)
3. Request token from callback → exchange for access token

**TOTP kya hai (clarification):**
- "OTP" jo tu Authy app mein dekhta hai, wo **Zerodha SE NAHI aata** — Authy khud generate karta hai.
- Authy ke paas ek **secret key** stored hai (jab setup kiya tha tab QR code se mili thi).
- Har 30 sec mein `TOTP = HMAC-SHA1(secret_key, current_time / 30)` formula se 6-digit code calculate hota hai.
- **Agar humein wahi secret key mil jaye, hum `pyotp` library se same code generate kar sakte hain Python mein.**

**Iska matlab auto-login possible hai — TOTP secret ke saath.**

**Industry practice:** 90%+ B-book platforms (Aliceblue, Finvasia, custom B-books) Playwright/Selenium headless auto-login use karti hain. Production-tested for years.

---

## 3. High-level architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   APScheduler (in main.py lifespan)         │
│  Daily 07:00 IST (Mon-Fri, skip weekends + Indian holidays) │
└────────────────────┬────────────────────────────────────────┘
                     │ triggers
                     ▼
┌─────────────────────────────────────────────────────────────┐
│           zerodha_auto_login_service.refresh_now()          │
│  1. Load encrypted creds from ZerodhaAutoLogin doc          │
│  2. Decrypt with AES-256-GCM (key from .env)                │
│  3. Launch Playwright Chromium (headless)                   │
│  4. Navigate to Kite login URL with apiKey param            │
│  5. Fill username + password → submit                       │
│  6. Generate TOTP code with pyotp → fill → submit           │
│  7. Wait for redirect to /admin/zerodha/callback?req=...    │
│  8. Extract request_token from URL                          │
│  9. Call zerodha_service.generate_session(request_token)    │
│ 10. New access_token saved → WS pool reconnects             │
└────────────────────┬────────────────────────────────────────┘
                     │ on success: log audit + notification
                     │ on failure: retry 3× → alert admin
                     ▼
┌─────────────────────────────────────────────────────────────┐
│  Existing zerodha_service.generate_session() — UNCHANGED    │
│  Saves access_token to ZerodhaSettings → emits WS reconnect │
└─────────────────────────────────────────────────────────────┘
```

**Key principle:** Existing manual login flow **untouched** — auto-login just calls the same `generate_session()` method that the manual callback uses. If auto-login fails for any reason, admin can still manually login through the existing UI as fallback.

---

## 4. Components in detail

### 4.1 New model — `ZerodhaAutoLogin`

**File:** `backend/app/models/zerodha_auto_login.py`

```python
class ZerodhaAutoLogin(TimestampMixin):
    """Singleton document storing encrypted Kite login credentials for
    automated daily token refresh. Only the super-admin can read/write
    these — credentials are AES-256-GCM encrypted at rest with the key
    from ZERODHA_CREDS_KEY env var."""

    encrypted_username: str = ""      # AES-GCM ciphertext, base64
    encrypted_password: str = ""
    encrypted_totp_secret: str = ""
    enc_iv: str = ""                  # 12-byte IV, base64 (one per row, rotated)

    is_enabled: bool = False           # master kill-switch
    schedule_time_ist: str = "07:00"   # HH:MM in IST, configurable

    last_attempt_at: datetime | None = None
    last_success_at: datetime | None = None
    last_status: str = ""              # "success" / "failed: <reason>"
    last_error_detail: str | None = None
    consecutive_failures: int = 0

    class Settings:
        name = "zerodha_auto_login"
```

**Why a separate collection** (not extending `ZerodhaSettings`):
- Different access scope (super-admin only vs general admin).
- Larger fields (encrypted blobs) — keep `ZerodhaSettings` queryable for status checks.
- Audit trail separation — credential access is high-sensitivity.

---

### 4.2 Encryption utility — `app/utils/crypto.py`

```python
"""AES-256-GCM symmetric encryption for credential storage.

Key comes from ZERODHA_CREDS_KEY env var (32 bytes, base64-encoded).
Generate with: openssl rand -base64 32
"""

def encrypt(plaintext: str, *, key: bytes | None = None) -> tuple[str, str]:
    """Returns (ciphertext_b64, iv_b64). Caller stores both."""

def decrypt(ciphertext_b64: str, iv_b64: str, *, key: bytes | None = None) -> str:
    """Reverses encrypt()."""
```

**Library:** `cryptography` (already a transitive dependency of `kiteconnect`).

**Security guarantees:**
- AES-256-GCM = authenticated encryption (tamper detection built in).
- New IV per encryption (12 bytes random) — same plaintext encrypts to different ciphertext.
- Key never written to disk (only env var) — `.env` file in `/etc/marginplant/` with 600 permissions.

---

### 4.3 Auto-login service — `app/services/zerodha_auto_login.py`

**Public API:**

```python
class ZerodhaAutoLoginService:
    async def save_credentials(
        self,
        username: str,
        password: str,
        totp_secret: str,
        *,
        actor_id: PydanticObjectId,
    ) -> None:
        """Encrypt + persist. Audit logged. Raises on invalid TOTP secret."""

    async def get_status(self) -> dict:
        """Masked status for admin UI. NEVER returns plaintext creds."""
        # Returns:
        # {
        #   "is_configured": True,
        #   "is_enabled": True,
        #   "schedule_time_ist": "07:00",
        #   "last_attempt_at": "2026-05-22T01:30:00Z",
        #   "last_success_at": "2026-05-22T01:30:15Z",
        #   "last_status": "success",
        #   "consecutive_failures": 0,
        #   "username_masked": "ZS****1",
        # }

    async def refresh_now(self) -> dict:
        """Run the full Playwright login flow. Returns:
        {
          "success": True,
          "access_token_obtained": True,
          "duration_ms": 18432,
        }
        On failure: { "success": False, "error": "...", "stage": "totp_submit" }
        """

    async def set_enabled(self, enabled: bool, *, actor_id: PydanticObjectId) -> None:
        """Toggle the daily scheduler. Audit logged."""

    async def is_due(self) -> bool:
        """Called by scheduler — True when it's time to fire."""
```

**Playwright flow (the heart of it):**

```python
async def _run_login_flow(self, username: str, password: str, totp_secret: str) -> str:
    """Returns the access_token. Raises on any failure with detailed stage."""
    from playwright.async_api import async_playwright
    import pyotp

    settings = await self._get_zerodha_settings()
    if not settings.apiKey:
        raise RuntimeError("Kite apiKey not configured")

    login_url = f"https://kite.zerodha.com/connect/login?v=3&api_key={settings.apiKey}"

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage"],
        )
        try:
            context = await browser.new_context(
                user_agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                viewport={"width": 1280, "height": 720},
            )
            page = await context.new_page()

            # Stage 1: navigate
            await page.goto(login_url, wait_until="networkidle", timeout=15_000)

            # Stage 2: username + password
            await page.fill('input[id="userid"]', username)
            await page.fill('input[id="password"]', password)
            await page.click('button[type="submit"]')

            # Stage 3: TOTP (Authy code) — wait for the TOTP screen
            await page.wait_for_selector('input[id="userid"]', state="detached", timeout=10_000)
            await page.wait_for_selector('input[type="text"]', timeout=10_000)

            totp_code = pyotp.TOTP(totp_secret).now()
            await page.fill('input[type="text"]', totp_code)
            await page.click('button[type="submit"]')

            # Stage 4: wait for redirect to /callback?request_token=...
            await page.wait_for_url(
                lambda url: "request_token=" in url,
                timeout=15_000,
            )

            final_url = page.url
            request_token = self._extract_request_token(final_url)
            if not request_token:
                raise RuntimeError(f"request_token not found in redirect: {final_url}")

            # Stage 5: exchange via existing zerodha_service
            data = await zerodha_service.generate_session(request_token)
            return data["access_token"]
        finally:
            await browser.close()
```

**Edge cases handled:**
- Wrong password → Kite shows error banner → script detects via DOM selector → fail immediately
- TOTP failure (clock skew) → retry once with fresh OTP after 30 sec wait
- CAPTCHA appears → detected → admin alert → manual fallback
- Network timeout → retry 3× with exponential backoff (5s, 15s, 45s)
- Kite login UI change → script throws clear error pointing at which stage broke

---

### 4.4 Scheduler — extend `main.py` lifespan

Existing pattern in `main.py`:
- Background asyncio tasks for `market_tick_loop`, `pending_order_poller`, `risk_enforcer_loop`.

Add new task:

```python
async def _zerodha_auto_login_scheduler():
    """Daily 07:00 IST trigger. Skips weekends. Retries on failure."""
    while True:
        try:
            await asyncio.sleep(_seconds_until_next_run())  # always wakes at 07:00 IST
            today_ist = datetime.now(IST).date()
            if today_ist.weekday() >= 5:  # Sat/Sun
                continue
            if await holiday_service.is_market_holiday(today_ist):
                continue
            if not await zerodha_auto_login.is_enabled():
                continue

            for attempt in range(1, 4):
                result = await zerodha_auto_login.refresh_now()
                if result["success"]:
                    break
                await asyncio.sleep(300)  # 5 min between retries
            else:
                # All 3 attempts failed — alert
                await _alert_admin_token_refresh_failure(result)
        except Exception:
            logger.exception("zerodha_auto_login_scheduler_iter_failed")
            await asyncio.sleep(60)
```

**Single-leader guard (multi-worker safety):**
- When backend runs with 4 uvicorn workers, only ONE should run this scheduler.
- Use Redis SETNX lock: `SET zerodha_auto_login:leader <hostname> NX EX 600`
- Worker that wins the lock runs the scheduler; others skip.

---

### 4.5 Admin API endpoints — `app/api/v1/admin/zerodha_auto_login.py`

```python
@router.get("/zerodha/auto-login")
async def get_status(admin: CurrentAdmin):
    """Returns masked status. Available to super-admin only."""

@router.put("/zerodha/auto-login/credentials")
async def update_credentials(
    payload: UpdateCredentialsPayload,
    admin: CurrentAdmin,
    request: Request,
):
    """Stores encrypted creds. Super-admin only. Rate-limited 1/min."""

@router.post("/zerodha/auto-login/toggle")
async def toggle(payload: ToggleRequest, admin: CurrentAdmin):
    """Enable/disable the daily scheduler."""

@router.post("/zerodha/auto-login/test")
async def test_now(admin: CurrentAdmin):
    """Triggers immediate login attempt. Useful for verifying setup
    before enabling the daily scheduler."""

@router.put("/zerodha/auto-login/schedule")
async def set_schedule(payload: SchedulePayload, admin: CurrentAdmin):
    """Change the daily trigger time (HH:MM IST)."""
```

**Authorization:**
- All endpoints require `CurrentAdmin` AND `is_super_admin()` check.
- Rate-limited via Redis: 1 credential update per minute, 5 test-login attempts per hour.

---

### 4.6 Admin UI — extend `/zerodha` page

Existing page (`frontend-admin/app/(admin)/zerodha/page.tsx`) shows manual login + status. Add:

**New section: "Auto-login"**

```
┌─────────────────────────────────────────────────────────┐
│  Auto-login                                  [● Enabled] │
├─────────────────────────────────────────────────────────┤
│  Schedule:  [ 07:00 IST ▼ ]    (Monday-Friday)          │
│                                                         │
│  Last attempt:  2026-05-22 07:00:18 IST   ✓ Success    │
│  Last success:  2026-05-22 07:00:18 IST                 │
│  Failures (consecutive): 0                              │
│                                                         │
│  [ Update credentials ]   [ Test login now ]            │
└─────────────────────────────────────────────────────────┘

──── Credentials modal (when "Update credentials" clicked) ────
┌─────────────────────────────────────────────────────────┐
│  Kite Login Credentials  ⚠️ Encrypted at rest            │
├─────────────────────────────────────────────────────────┤
│  Kite Client ID:   [ ZK****                          ]  │
│  Password:         [ ●●●●●●●●●●                      ]  │
│  TOTP Secret:      [ JBSWY3DPEHPK3PXP...             ]  │
│                    (16-32 char string from Kite TOTP)   │
│                                                         │
│  [ How to get TOTP secret ]                             │
│                                                         │
│  ⚠️ Warning: These credentials enable automated login    │
│  on your behalf. Store with care.                       │
│                                                         │
│  [ Cancel ]              [ Save & Test ]                │
└─────────────────────────────────────────────────────────┘
```

**Frontend file additions:**
- `frontend-admin/app/(admin)/zerodha/page.tsx` — extend existing
- `frontend-admin/components/zerodha/AutoLoginPanel.tsx` — new component
- `frontend-admin/components/zerodha/CredentialsModal.tsx` — new component
- `frontend-admin/lib/api.ts` — add `ZerodhaAutoLoginAPI`

---

### 4.7 Failure notifications

When auto-login fails (all 3 retries exhausted):

1. **AdminNotification row** created with high severity:
   - Title: "Zerodha auto-login failed"
   - Message: "Manual login required — market opens in N minutes"
   - Link: `/zerodha`
2. **WhatsApp message** sent to super-admin's `support_whatsapp` number (uses existing infra from earlier feature):
   - "🚨 MarginPlant: Zerodha auto-login failed at 07:00 IST. Please manual login at admin.marginplant.com/zerodha — market opens at 09:15 IST."
3. **Audit log entry** with full failure detail (stage, error, stack trace)
4. **Sentry alert** (if integrated)

---

## 5. Security architecture

### 5.1 Threat model

**What we're protecting against:**
- DB dump leak (malicious insider, backup compromise)
- Application server breach (RCE, supply chain attack)
- Developer/admin misuse (curiosity reading raw creds)

**What we cannot fully protect against:**
- Root-level server compromise (attacker has env vars + DB + process memory) — same as any encryption-at-rest scheme
- Kite account suspension by Zerodha for automated login pattern (low risk, but exists)

### 5.2 Defense layers

| Layer | Mitigation |
|---|---|
| Storage | AES-256-GCM encrypted in MongoDB |
| Key management | `ZERODHA_CREDS_KEY` env var, separate from JWT secret, file perms 600 |
| API access | Super-admin only, JWT + admin API key + 2FA |
| Read protection | API responses always return masked values (no raw creds) |
| Audit | Every credential access (read/write) audit-logged |
| Rate limiting | 1 credential update per minute, 5 test logins per hour |
| Network | Playwright subprocess isolated (no DB access during browser run) |
| Code review | Encryption key never logged, masked in stack traces |
| Trade scope | Use Kite "no_trading" API key permission (orders blocked at Kite even if compromised) |

### 5.3 Compromise recovery procedure

If credentials suspected compromised:

1. **Change Kite password immediately** at kite.zerodha.com
2. **Reset TOTP** at Kite (new QR + new secret)
3. **Generate new encryption key** in production env
4. Re-encrypt existing rows with new key (one-time migration)
5. Update admin UI with new creds
6. **Audit log review** — check all credential access in last 30 days

---

## 6. TOTP secret extraction — step-by-step

**Admin needs to do this ONCE before enabling auto-login.**

### Step 1: Login to Kite
- Browser: https://kite.zerodha.com
- Use current credentials + Authy 6-digit code

### Step 2: Open settings
- Top-right profile icon → "My Profile" / "Settings"
- Left sidebar: "Account" → "Password & Security"

### Step 3: Find TOTP section
- Look for "External TOTP" or "Two-Factor Authentication"
- Will say "External 2FA is enabled" or similar

### Step 4: Reset TOTP to reveal secret
- Click "Reset TOTP" / "Disable & Re-enable" / "Set up again"
- Kite may ask to re-authenticate — do so
- New QR code will appear

### Step 5: Get the secret (DON'T scan QR)
- Below the QR code, find: "Can't scan?" / "Manual entry" / "Show secret key"
- Click it
- A 16-32 character string appears, like: `JBSWY3DPEHPK3PXP6X7K3RVDFY5GXEEHM3HJ`
- **Copy this string** to a secure note (NOT screenshot)

### Step 6: Re-add to Authy
- **CRITICAL** — don't just save the new secret to backend; Authy needs it too
- Open Authy → "Add Account" → "Enter Code Manually"
- Paste the same secret
- Account name: "Zerodha" or "Kite"
- Verify Authy now generates a 6-digit code

### Step 7: Verify both match
- Authy shows code (e.g., `123456`)
- Kite setup screen asks for verification code
- Enter the code from Authy → submit
- ✅ Setup complete; both phone and backend will use same secret

### Step 8: Save securely for backend
- Store the secret in: Bitwarden / 1Password / phone encrypted notes
- Will be pasted into admin UI later (encrypted at rest in backend DB)

**⚠️ DO NOT:**
- Don't take screenshots of the secret (Google Photos sync leaks)
- Don't email yourself the secret
- Don't paste into general notes apps (Evernote, Apple Notes without device encryption)
- Don't share via WhatsApp / Telegram
- Don't delete the old Authy entry until the new one is verified working

**Recovery if locked out:**
- Kite support: 1800-419-3001 (8 AM - 8 PM IST)
- Email: support@zerodha.com
- Requires PAN + DOB verification

---

## 7. Phase-wise implementation plan (5 days)

### Day 1 — Model, encryption, service skeleton (no Kite interaction)
- [ ] Add `cryptography` to `backend/requirements.txt` (likely already there via kiteconnect)
- [ ] Add `playwright` to `backend/requirements.txt`
- [ ] Add `pyotp` to `backend/requirements.txt`
- [ ] Create `backend/app/utils/crypto.py` — AES-GCM encrypt/decrypt
- [ ] Create `backend/app/models/zerodha_auto_login.py` — singleton document
- [ ] Register in `backend/app/core/database.py:_document_models()`
- [ ] Add `ZERODHA_CREDS_KEY` to `Settings` in `backend/app/core/config.py`
- [ ] Create `backend/app/services/zerodha_auto_login.py` with skeleton:
  - `save_credentials()` — encrypts + saves, audit logs
  - `get_status()` — returns masked status
  - `refresh_now()` — stub raises NotImplementedError for now
- [ ] Unit test: encrypt → decrypt round-trip
- [ ] Unit test: save → status returns masked username
- [ ] **Verify:** ruff format, mypy, pytest pass

### Day 2 — Playwright login flow (the risky day)
- [ ] Install Playwright dependencies: `playwright install chromium`
- [ ] On dev laptop FIRST — write `scripts/zerodha_test_login.py`:
  - Reads creds from `.env` directly
  - Runs HEADED Playwright (not headless) so we can see what happens
  - Logs every stage with screenshot saved to `/tmp/`
- [ ] Run on operator's actual Kite account (operator watches the headed browser)
- [ ] Iterate on selectors until login completes reliably
- [ ] Handle edge cases:
  - Wrong password (test with bad pwd)
  - Wrong TOTP (test with hardcoded bad OTP)
  - Network slow (introduce `await asyncio.sleep(2)`)
  - CAPTCHA (force-trigger by login 5× rapidly)
- [ ] Once headed mode is rock-solid, switch to headless and verify again
- [ ] Move proven flow into `zerodha_auto_login.py` service
- [ ] **Verify:** local test login produces valid access_token, stored in DB

### Day 3 — Scheduler + multi-worker safety
- [ ] Add `_zerodha_auto_login_scheduler()` task in `main.py` lifespan
- [ ] Redis-based single-leader lock (`zerodha_auto_login:leader` key, 600s TTL)
- [ ] Holiday check via existing `holiday_service`
- [ ] Weekend check (Sat/Sun skip)
- [ ] Retry logic: 3 attempts, 5 min gap each
- [ ] Failure → create `AdminNotification` + WhatsApp via existing support number
- [ ] **Verify:** override schedule_time to current+2 min, wait, confirm login fires

### Day 4 — Admin API + UI
- [ ] Backend: `backend/app/api/v1/admin/zerodha_auto_login.py` with all 5 endpoints
- [ ] Register in `backend/app/api/v1/admin/__init__.py`
- [ ] Frontend: `frontend-admin/lib/api.ts` — `ZerodhaAutoLoginAPI`
- [ ] Frontend: `AutoLoginPanel.tsx` component
- [ ] Frontend: `CredentialsModal.tsx` with form + "How to get TOTP secret" link
- [ ] Frontend: extend `app/(admin)/zerodha/page.tsx` to render the new section
- [ ] Confirmation dialog when enabling auto-login (security warning)
- [ ] **Verify:** end-to-end through browser — save creds, test, enable, see status update

### Day 5 — Production hardening + rollout
- [ ] Full audit logging review (every cred access)
- [ ] Rate limiting on `/admin/zerodha/auto-login/credentials` (1/min)
- [ ] Rate limiting on `/test` endpoint (5/hour)
- [ ] Sentry breadcrumbs at every Playwright stage
- [ ] README section in repo: setup steps + recovery procedure
- [ ] Production install: `playwright install chromium` on EC2 (deploy script update)
- [ ] Deploy backend → admin UI visible at `/zerodha`
- [ ] **Soft launch:** operator saves creds, runs "Test login" manually for 3 days
- [ ] After 3 days of clean manual test runs, enable the daily scheduler
- [ ] Monitor for 1 week alongside manual login fallback availability
- [ ] After 2 weeks of zero failures, declare GA

---

## 8. Failure recovery — operational runbook

### Scenario A: Daily auto-login fails at 07:00 IST

1. **Detection** (within 10 sec of 3rd retry failing):
   - Bell icon notification on admin panel
   - WhatsApp message to super-admin
   - Sentry alert (if configured)

2. **Manual fallback** (admin gets the alert):
   - Open `https://admin.marginplant.com/zerodha`
   - Click "Login with Kite" (existing manual flow)
   - Complete Authy verification
   - Total time: ~30 seconds

3. **Root cause** (post-incident):
   - Open audit log filtered by `ZERODHA_AUTO_LOGIN`
   - Check `last_error_detail` field for exact failure stage
   - Common causes:
     - CAPTCHA appeared (very rare; Kite throttling) → wait 1 hour, retry
     - Kite login UI changed → update Playwright selectors (1-2 hour fix)
     - Wrong creds (admin changed Kite password) → update credentials in admin UI
     - Network glitch from EC2 → AWS network issue, transient

### Scenario B: Kite changes their login page

**Symptoms:** All auto-logins fail with selector-not-found error.

**Fix:**
1. Run `scripts/zerodha_test_login.py` in HEADED mode on dev laptop
2. Watch the new UI, update selectors in `zerodha_auto_login.py`
3. Test → deploy
4. ETA: 1-2 hours dev time

**Pre-emptive monitoring:** Setup a weekly Saturday morning test-login (when admin is awake) — catches UI changes before they hit Monday market open.

### Scenario C: Credentials compromised

1. Immediately disable auto-login via admin UI toggle
2. Change Kite password at kite.zerodha.com
3. Reset TOTP (generate new secret)
4. Generate new `ZERODHA_CREDS_KEY` for backend
5. Update admin UI with new credentials
6. Audit log review — check who accessed creds in last 30 days

### Scenario D: Backend can't connect to Kite at all (Kite outage)

- Auto-login fails with network error → retries 3×, then alert
- Manual login also fails (same network issue)
- This is a Zerodha-side problem, not ours
- Status page: https://kite.zerodha.com (Kite themselves announce outages)
- Wait it out — when Kite recovers, run manual login or restart backend (scheduler will retry next cycle)

---

## 9. Risks & open questions

### Known risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Kite ToS gray area on automation | Low | Account ban (worst case) | Use "no_trading" API key permission so even compromise = read-only; randomize login time within 5-min window |
| Login UI changes | Medium (1×/year) | All auto-logins fail | Weekend test-login canary catches early; 2-hour fix turnaround |
| CAPTCHA triggered | Low | Single-day failure | Detected → manual fallback notification |
| TOTP secret compromise | Low | Full Kite read access | AES-256-GCM + key in env + audit + "no_trading" permission |
| Playwright Chromium memory leak | Low | Backend OOM after weeks | Process spawned + killed per login; not long-running |
| Scheduler runs in multiple workers | Medium | Multiple parallel logins → Kite rejects | Redis SETNX lock with 600s TTL |
| Daylight saving / clock drift | Low | TOTP fails (30-sec window) | NTP sync on server (already standard); pyotp uses system clock |

### Open questions to resolve before Day 1

- [ ] **Operator decision:** Use "no_trading" Kite API key permission? (Recommended — zero downside since orders never go to Kite anyway in B-book.)
- [ ] **Operator decision:** WhatsApp alert recipient — super-admin's `support_whatsapp` or a different "emergency" number?
- [ ] **Operator decision:** What time do you want as default? (Default plan: 07:00 IST = 2 hours before market open.)
- [ ] **Hosting:** Does EC2 instance have enough disk for Playwright Chromium (~250MB)? Currently t3.medium = 20GB EBS = ample.
- [ ] **Sentry:** Is it set up? If not, fail-loud via logs + WhatsApp alone for v1.

---

## 10. Success metrics

After 2 weeks of running auto-login:

- ✅ **0 missed market opens** due to manual login lapse
- ✅ **<1% failure rate** on daily auto-login (≤1 failure in 14 attempts)
- ✅ **<20 seconds** average auto-login duration (Playwright start → access_token saved)
- ✅ **0 security incidents** (no unauthorized credential access, no Kite suspensions)
- ✅ **Operator confidence** — admin no longer sets 7 AM alarms manually

---

## 11. Out of scope for v1

Things we're explicitly NOT doing in this round:

- ❌ Multi-account Kite support (sharding across multiple API keys for >3000 tokens) — separate project
- ❌ Token refresh API (Kite doesn't expose; would need algo trading license)
- ❌ Auto-detection of CAPTCHA via image recognition — too complex; admin manual fallback is fine
- ❌ Encrypted credentials backup/export — too risky; if you lose the key, just re-enter creds
- ❌ Multi-region failover (run auto-login from 2nd region if primary fails) — overengineered for current scale

---

## 12. References

- [Kite Connect API docs](https://kite.trade/docs/connect/v3/) — official OAuth flow we're automating
- [Playwright Python docs](https://playwright.dev/python/) — headless browser library
- [pyotp library](https://pyauth.github.io/pyotp/) — TOTP code generation
- [AES-GCM in cryptography package](https://cryptography.io/en/latest/hazmat/primitives/aead/) — encryption primitive
- Internal: `backend/app/services/zerodha_service.py` — existing manual flow we're extending
- Internal: `backend/app/api/v1/admin/zerodha.py` — existing admin endpoints
- Internal: `backend/app/models/zerodha_settings.py` — existing settings document

---

**Status:** Plan finalized, awaiting operator green-light to start Day 1.

**Total estimated effort:** 5 working days (1 dev, no parallelism).

**Total cost impact:** ₹0 — runs on existing infrastructure.

**Reversibility:** Fully reversible — disable toggle in admin UI = manual login still works exactly as today.
