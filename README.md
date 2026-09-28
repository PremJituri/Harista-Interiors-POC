# Harista Interiors — Website & Dynamic Portfolio CMS

A fast, lightweight, and responsive commercial website for **Harista Interiors** (Belagavi), featuring a nested dynamic portfolio CMS.

---

## 🏛 Architecture Overview

* **Frontend**: Vanilla HTML5, CSS3, Tailwind CSS (via CDN), ES modules.
  * `index.html`: Marketing showcase, services, factory overview, portfolio preview, and interactive contact section with Google Maps.
  * `our-work.html`: Interactive, hierarchical public portfolio gallery supporting nested collections (up to 4 levels), deep linking (`/gallery/:slug` and `?album=:slug`), client-side in-memory caching, responsive mobile drawer navigation, and accessible modal lightbox.
  * `admin-login.html`: Secure administrative authentication portal with password toggle and session persistence.
  * `admin.html`: Administrative CMS dashboard to manage root collections, create sub-albums up to 4 levels, drag-and-drop photo uploads (with Sharp re-encoding), select/bulk delete, and cascading deletion with disk cleanup.
* **Backend**: Node.js ES modules, Express 4, SQLite (`sql.js`), Sharp image processing, bcrypt, JWT authentication.
  * Zero-dependency database: SQLite with automated schema migrations, foreign keys, and indexes.
  * Caching: HTTP 304 / `Cache-Control` static asset headers (7 days for uploads, 1 day for assets).
  * Security: MIME-restricted uploads (JPEG, PNG, WebP, AVIF), 25MB body limit, UUID re-encoding, path traversal protection (`path.basename`), hardened CORS, and central error masking.

---

## 🚀 Quick Start (Local Development)

### 1. Prerequisites
* **Node.js** (v18.0.0 or higher recommended)
* **npm** (v9 or higher)

### 2. Installation
From the root directory:
```bash
# Navigate to backend directory and install dependencies
cd backend
npm install
```

### 3. Environment Configuration
Create or configure `backend/.env` (a template is provided in `backend/.env.example`):
```ini
PORT=5000
JWT_SECRET=your_super_secret_jwt_key_here
```

### 4. Running the Application
From the root directory:
```bash
npm start
```
Or directly from `backend/`:
```bash
cd backend
npm start
```

Access the application in your browser:
* **Website**: [http://localhost:5000](http://localhost:5000)
* **Gallery**: [http://localhost:5000/our-work.html](http://localhost:5000/our-work.html) or [http://localhost:5000/gallery](http://localhost:5000/gallery)
* **Admin Login**: [http://localhost:5000/admin-login.html](http://localhost:5000/admin-login.html)
* **Admin Dashboard**: [http://localhost:5000/admin.html](http://localhost:5000/admin.html)

---

## 🔐 Admin Authentication
* Default credentials are created on first database initialization:
  * **Username**: `HaristaInteriors`
  * **Password**: Provided securely to the client (seeded via pre-computed bcrypt hash; never stored in plaintext within the codebase)
* Passwords are encrypted using `bcrypt` (10 salt rounds) stored in `backend/data/app.db`.
* *Optional customization*: To seed custom admin credentials when creating a new database, define `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `backend/.env`.

---

## 🌐 Production Deployment

### 1. Set Production Environment
In `backend/.env`:
```ini
PORT=5000
NODE_ENV=production
JWT_SECRET=generate_a_long_random_cryptographic_secret
ALLOWED_ORIGINS=https://haristainteriors.com,https://www.haristainteriors.com
```

### 2. Process Management (PM2)
To keep the server running continuously in production:
```bash
npm install -g pm2
pm2 start backend/server.js --name "harista-interiors"
pm2 save
pm2 startup
```

### 3. Reverse Proxy Configuration (Nginx Example)
```nginx
server {
    listen 80;
    server_name haristainteriors.com www.haristainteriors.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name haristainteriors.com www.haristainteriors.com;

    # SSL Certificates
    ssl_certificate /etc/letsencrypt/live/haristainteriors.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/haristainteriors.com/privkey.pem;

    client_max_body_size 30M;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 🧪 Verification & Test Suites

The project includes automated regression test suites covering all phases:
* `verify_phase1.mjs`: Project structure, dead code elimination, route integrity.
* `verify_phase2.mjs`: Security, JWT tokens, authentication, upload filter, path safety.
* `verify_phase3.mjs`: Database indexing, 4-level nesting limits, cascading deletion.
* `verify_phase4.mjs`: Caching headers, prepared statements, DOM fragments, touch-guarded tilt.
* `verify_phase5.mjs`: Mobile navigation drawers, modal ARIA semantics, backdrop and Escape dismissals.
* `verify_phase6.mjs`: Comprehensive end-to-end integration and deployment readiness.

To run tests:
```bash
node test/verify_all.mjs
```

---

## 📄 License
Private commercial website for Harista Interiors. All rights reserved.
