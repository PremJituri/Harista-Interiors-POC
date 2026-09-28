import express from 'express';
import cors from 'cors';
import { mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { getDb } from './db/database.js';
import { createAuthRouter } from './routes/auth.js';
import { createAlbumsRouter } from './routes/albums.js';
import { createImagesRouter } from './routes/images.js';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const uploadsDir = join(__dirname, 'uploads');
const dataDir = join(__dirname, 'data');

for (const dir of [dataDir, uploadsDir]) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

const PORT = Number(process.env.PORT) || 5000;

async function main() {
  const db = await getDb();
  const app = express();

  const isProduction = process.env.NODE_ENV === 'production';
  const configuredOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : [];

  app.disable('x-powered-by');

  app.use(cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. server-side calls, curl, same-origin)
      if (!origin) return callback(null, true);

      if (!isProduction) {
        return callback(null, true);
      }

      if (configuredOrigins.length > 0 && configuredOrigins.includes(origin.toLowerCase())) {
        return callback(null, true);
      }

      return callback(new Error('CORS blocked: origin not allowed'));
    },
    credentials: true,
  }));
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;
  const SEVEN_DAYS_MS = 7 * ONE_DAY_MS;

  app.use(express.json({ limit: '10mb' }));
  app.use('/uploads', express.static(uploadsDir, { maxAge: SEVEN_DAYS_MS }));

  // Serve static assets and frontend files
  const projectRoot = join(__dirname, '..');
  app.use('/assests', express.static(join(projectRoot, 'assests'), { maxAge: ONE_DAY_MS }));
  app.use('/assets', express.static(join(projectRoot, 'assests'), { maxAge: ONE_DAY_MS }));
  app.use(express.static(projectRoot, { maxAge: 0 }));

  const authRouter = createAuthRouter(db);
  const albumsRouter = createAlbumsRouter(db, uploadsDir);
  const imagesRouter = createImagesRouter(db, uploadsDir);

  app.use('/api/auth', authRouter);
  app.use('/api/albums', albumsRouter);
  app.use('/api/images', imagesRouter);

  // Deep linking: support /gallery and /gallery/* paths loading our-work.html
  app.get(['/gallery', '/gallery/*'], (_req, res) => {
    res.sendFile(join(projectRoot, 'our-work.html'));
  });

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, project: 'Harista Interiors' });
  });

  // Central error handling middleware: prevents internal path and stack trace leaks
  app.use((err, _req, res, _next) => {
    const isMulter = err.name === 'MulterError';
    const isCors = err.message && err.message.includes('CORS');
    const status = isCors ? 403 : (isMulter || err.status === 400 ? 400 : 500);

    console.error(`[Server Error ${status}]:`, err.message);

    res.status(status).json({
      error: status === 500 ? 'Internal server error' : err.message,
    });
  });

  const server = app.listen(PORT, () => {
    console.log(`Harista Interiors backend listening on http://localhost:${PORT}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use.`);
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}

main().catch((err) => {
  console.error('Server startup error:', err);
  process.exit(1);
});
