# Deployment

CI/CD lives in `.github/workflows/`:

| Workflow | Trigger | Purpose |
|----------|---------|---------|
| `ci.yml` | every push / PR | lint + type-check + build verify |
| `deploy.yml` | push to `main` (and manual) | SSH → EC2 → run `scripts/deploy.sh` |

The actual deploy script is `scripts/deploy.sh` — it's invoked by the
GitHub Action over SSH but can also be run by hand on the EC2.

## One-time setup

### 1. GitHub repository secrets

`Settings → Secrets and variables → Actions → New repository secret`. Add:

| Secret | Value |
|--------|-------|
| `EC2_HOST` | `100.48.201.136` (or whatever your elastic IP is) |
| `EC2_USER` | `ubuntu` |
| `EC2_SSH_KEY` | paste the full contents of `setupfx.io.pem` (the PRIVATE key, including the `-----BEGIN OPENSSH PRIVATE KEY-----` and `-----END OPENSSH PRIVATE KEY-----` lines) |
| `EC2_PORT` | `22` (optional — defaults to 22) |

> Use a deploy-only SSH key in production. The current key gives full sudo
> access to the box, which is fine for a single-developer project but you
> should rotate or restrict it later.

### 2. EC2 passwordless sudo for the systemctl + nginx commands

`scripts/deploy.sh` calls `sudo systemctl restart …` and `sudo nginx -t`.
Without a TTY, sudo will block waiting for a password. Allow the `ubuntu`
user to run only those commands without a password:

```bash
sudo visudo -f /etc/sudoers.d/setupfx-deploy
```

Paste:

```
ubuntu ALL=(root) NOPASSWD: /usr/bin/systemctl restart setupfx-backend
ubuntu ALL=(root) NOPASSWD: /usr/bin/systemctl reload nginx
ubuntu ALL=(root) NOPASSWD: /usr/sbin/nginx -t
ubuntu ALL=(root) NOPASSWD: /usr/bin/cp * /etc/nginx/sites-available/setupfx
```

Save (`Ctrl+O`, `Enter`, `Ctrl+X`). visudo will syntax-check before
writing, so a typo here won't lock you out.

### 3. Make sure the EC2 has the repo at `/opt/setupfx`

If you haven't already:

```bash
sudo mkdir -p /opt/setupfx
sudo chown ubuntu:ubuntu /opt/setupfx
git clone https://github.com/shivammacoss/setupfx_ind.git /opt/setupfx
chmod +x /opt/setupfx/scripts/deploy.sh
```

### 4. Trigger the first deploy

Push to `main` (any commit, even a README touch). Watch
`Actions → Deploy to EC2` in GitHub. You should see:

1. SSH connects to `100.48.201.136`
2. `scripts/deploy.sh` runs — pulls, rebuilds only the changed pieces,
   restarts services
3. Healthchecks pass (backend returns 401 on auth-required endpoint,
   user/admin domains return 200/307)

## Manual deploy (no GitHub)

```bash
ssh -i setupfx.io.pem ubuntu@100.48.201.136
cd /opt/setupfx
bash scripts/deploy.sh
```

Force a full rebuild (ignore "no changes" optimisation):

```bash
FORCE_FULL=1 bash scripts/deploy.sh
```

## Manual rollback

GitHub Actions can re-run an older successful deploy job (`Actions →
Deploy → click old run → "Re-run all jobs"`). Or on the EC2:

```bash
cd /opt/setupfx
git reset --hard <old-sha>
FORCE_FULL=1 bash scripts/deploy.sh
```

## What gets rebuilt

`deploy.sh` diffs `HEAD` against `origin/main` and only touches the
affected pieces:

| Changed path | Action |
|--------------|--------|
| `backend/**` | restart `setupfx-backend.service` |
| `backend/requirements.txt` | `pip install -r requirements.txt` first |
| `frontend-user/**` | rebuild + `pm2 reload setupfx-user` |
| `frontend-user/package-lock.json` | `npm ci` first |
| `frontend-admin/**` | same, for admin app |
| `deploy/nginx/setupfx.conf` | copy to `/etc/nginx/sites-available/setupfx` + `nginx -t` + reload |

A clean deploy with **no app-code changes** finishes in ~5 seconds.
A build-required deploy runs ~2 minutes (npm build is the slow part).
