# Splitbene

Splitbene is an offline-first Splitwise-style app built with:

- Vite
- Alpine.js
- Tailwind CSS
- PocketBase
- vite-plugin-pwa

## Features

- Authentication required for app usage (register + login)
- Users only see groups where they are members
- Invite links that let new users register, login, and join groups
- Offline members supported for accurate split calculations (no login)
- Create/edit/delete groups
- Create/edit/delete members inside groups
- Create/edit/delete expenses
- Split modes: equal, percentage, or fixed amounts
- Expense defaults include all members with equal split
- Balance and settlement suggestions
- GBP currency formatting (`£`)
- PWA installability and offline local cache with sync

## Local development

```bash
npm install
npm run dev
```

Set PocketBase URL in `.env`:

```bash
VITE_POCKETBASE_URL=https://pocketbase.example.com
```

or set it in the app header panel.

## Build

```bash
npm run build
npm run preview
```

## PocketBase Setup

Create a PocketBase `users` auth collection and these app collections.

### 1. `groups`

Fields:
- `name` (text, required)
- `created_by` (relation -> `users`, required)
- `local_id` (text)
- `updated_at_client` (number)

### 2. `group_memberships`

Fields:
- `group` (relation -> `groups`, required)
- `user` (relation -> `users`, required)
- `role` (select/text, values: `owner`, `member`)
- `local_id` (text)
- `updated_at_client` (number)

### 3. `members`

Fields:
- `group` (relation -> `groups`, required)
- `auth_user` (relation -> `users`, optional, null for offline members)
- `name` (text, required)
- `email` (email/text)
- `is_offline` (bool)
- `invited` (bool)
- `local_id` (text)
- `updated_at_client` (number)

### 4. `expenses`

Fields:
- `group` (relation -> `groups`, required)
- `paid_by` (relation -> `members`, required)
- `description` (text, required)
- `amount` (number, required)
- `date` (date)
- `split_mode` (text/select: `equal`, `percentage`, `amount`)
- `splits` (json)
- `local_id` (text)
- `updated_at_client` (number)

## PocketBase Access Rules (important)

Set rules so authenticated users only access groups where they are members.

`groups`
- List/View/Update/Delete rule:
```txt
@request.auth.id != "" && group_memberships_via_group.user ?= @request.auth.id
```
- Create rule:
```txt
@request.auth.id != "" && created_by = @request.auth.id
```

`group_memberships`
- List/View rule:
```txt
@request.auth.id != "" && (user = @request.auth.id || group.group_memberships_via_group.user ?= @request.auth.id)
```
- Create rule:
```txt
@request.auth.id != "" && user = @request.auth.id
```
- Update/Delete rule:
```txt
@request.auth.id != "" && group.group_memberships_via_group.user ?= @request.auth.id
```

`members`
- List/View/Create/Update/Delete rule:
```txt
@request.auth.id != "" && group.group_memberships_via_group.user ?= @request.auth.id
```

`expenses`
- List/View/Create/Update/Delete rule:
```txt
@request.auth.id != "" && group.group_memberships_via_group.user ?= @request.auth.id
```

Notes:
- `group_memberships_via_group` is PocketBase's back-relation naming style.
- If your PB admin shows a different back-relation alias, use that alias in rules.

## Debian VPS Deployment (GitHub workflow)

This flow keeps the source code in GitHub, builds the frontend on the Debian VPS, and serves the built `dist/` folder with Nginx.

Assumptions:
- Your dev box already has this project checked out.
- You want GitHub to be the source of truth.
- The VPS will run both PocketBase and the frontend.
- Nginx will terminate TLS and reverse proxy PocketBase.

### 1. Prepare the repo on your dev box

This repo should ignore local-only files such as:
- `.env`
- `node_modules/`
- `dist/`
- local PocketBase data and downloaded binaries

If those files were already staged or tracked before `.gitignore` was added, remove them from Git without deleting your local copies:

```bash
git rm -r --cached --ignore-unmatch .env node_modules dist data/pocketbase.zip data/pocketbase_mac
```

Then commit the cleanup:

```bash
git add .gitignore README.md
git commit -m "Prepare repo for GitHub-based VPS deployment"
```

### 2. Create the GitHub repo and connect this project to it

Create an empty repository on GitHub, then run this from the project directory on your dev box:

```bash
git branch -M main
git remote add origin git@github.com:YOUR_GITHUB_USER/splitbene.git
git push -u origin main
```

If `origin` already exists, update it instead:

```bash
git remote set-url origin git@github.com:YOUR_GITHUB_USER/splitbene.git
git push -u origin main
```

### 3. Prepare the Debian VPS

Install the base packages first:

```bash
sudo apt update
sudo apt install -y nginx unzip curl git nodejs npm
```

If your Debian `nodejs` package is older than Node 20, upgrade Node before building this app.

### 4. Install PocketBase on the VPS

```bash
sudo useradd -r -m -d /opt/pocketbase -s /usr/sbin/nologin pocketbase || true
cd /tmp
curl -L -o pocketbase.zip https://github.com/pocketbase/pocketbase/releases/download/v0.26.2/pocketbase_0.26.2_linux_amd64.zip
sudo unzip -o pocketbase.zip -d /opt/pocketbase
sudo chown -R pocketbase:pocketbase /opt/pocketbase
```

Create `/etc/systemd/system/pocketbase.service`:

```ini
[Unit]
Description=PocketBase
After=network.target

[Service]
User=pocketbase
Group=pocketbase
WorkingDirectory=/opt/pocketbase
ExecStart=/opt/pocketbase/pocketbase serve --http=127.0.0.1:8090
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now pocketbase
sudo systemctl status pocketbase
```

PocketBase data should stay on the server in `/opt/pocketbase/pb_data`. Do not commit `pb_data` to GitHub.

### 5. Give the VPS access to the GitHub repo

If the repository is private, create an SSH key on the VPS and add the public key to GitHub as a deploy key:

```bash
ssh-keygen -t ed25519 -C "splitbene-vps" -f ~/.ssh/id_ed25519
cat ~/.ssh/id_ed25519.pub
```

Then add that public key in GitHub:
- Repository
- `Settings`
- `Deploy keys`
- `Add deploy key`

If the repository is public, you can skip the deploy key step and clone over HTTPS instead.

### 6. Clone the app on the VPS

```bash
sudo mkdir -p /var/www/splitbene
sudo chown "$USER":"$USER" /var/www/splitbene
cd /var/www/splitbene
git clone git@github.com:YOUR_GITHUB_USER/splitbene.git app
cd app
```

For a public repo, use:

```bash
git clone https://github.com/YOUR_GITHUB_USER/splitbene.git app
```

### 7. Create the production environment file on the VPS

Builds on the VPS should use a server-local env file that is not committed:

```bash
cd /var/www/splitbene/app
printf 'VITE_POCKETBASE_URL=https://splitbene.example.com/pb\n' > .env.production
```

### 8. Install dependencies and build on the VPS

```bash
cd /var/www/splitbene/app
npm ci
npm run build
```

This creates the production frontend in `/var/www/splitbene/app/dist`.

### 9. Configure Nginx

Create `/etc/nginx/sites-available/splitbene`:

```nginx
server {
    listen 80;
    server_name splitbene.example.com;

    root /var/www/splitbene/app/dist;
    index index.html;

    location / {
        try_files $uri /index.html;
    }

    location /pb/ {
        proxy_pass http://127.0.0.1:8090/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable the site:

```bash
sudo ln -sf /etc/nginx/sites-available/splitbene /etc/nginx/sites-enabled/splitbene
sudo nginx -t
sudo systemctl reload nginx
```

### 10. Enable HTTPS with Let's Encrypt

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d splitbene.example.com
```

### 11. Deploy future updates

On your dev box:

```bash
git add .
git commit -m "Describe your change"
git push
```

On the VPS:

```bash
cd /var/www/splitbene/app
git pull
npm ci
npm run build
sudo systemctl reload nginx
```

If you change PocketBase itself, restart it too:

```bash
sudo systemctl restart pocketbase
```

### 12. Point the app at PocketBase

Use:
- `https://splitbene.example.com/pb`

That value can live in `.env.production` on the VPS, or be set later in the app settings panel.

## Recommended production hardening

- Create daily backups of PocketBase `pb_data`.
- Run PocketBase behind firewall with only localhost bind.
- Use strong password policy for `users` collection.
- Disable open PB admin URL exposure after setup (VPN/IP allowlist if possible).
