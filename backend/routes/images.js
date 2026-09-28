import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { randomUUID } from 'crypto';
import { unlinkSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { requireAuth } from '../middleware/auth.js';

const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif']);
const ALLOWED_EXTENSIONS = /\.(jpe?g|png|webp|avif)$/i;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 50 },
  fileFilter: (_req, file, cb) => {
    const mimeOk = ALLOWED_MIME_TYPES.has(file.mimetype);
    const extOk = ALLOWED_EXTENSIONS.test(file.originalname);
    if (mimeOk && extOk) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, WebP, and AVIF images are permitted.'));
    }
  },
});

const MAX_WIDTH = 1920;
const JPEG_QUALITY = 85;

function sanitizeOriginalName(name) {
  if (!name || typeof name !== 'string') return 'image.jpg';
  const clean = basename(name).replace(/[^\w\s.-]/gi, '').trim();
  return clean.slice(0, 150) || 'image.jpg';
}

export function createImagesRouter(db, uploadsDir) {
  const router = Router();

  function deleteImageFile(filename) {
    if (!filename || typeof filename !== 'string') return;
    const safeName = basename(filename);
    const p = join(uploadsDir, safeName);
    if (existsSync(p)) {
      try {
        unlinkSync(p);
      } catch (err) {
        console.warn('Could not unlink image file:', safeName, err.message);
      }
    }
  }

  function refreshCoverIfNeeded(albumId, deletedFilename) {
    const album = db.prepare('SELECT cover_image FROM albums WHERE id = ?').get(albumId);
    if (!album) return;
    if (album.cover_image !== deletedFilename) return;
    const next = db
      .prepare('SELECT filename FROM images WHERE album_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(albumId);
    db.prepare('UPDATE albums SET cover_image = ? WHERE id = ?').run(next ? next.filename : null, albumId);
  }

  async function processAndSave(buffer, originalName) {
    const id = randomUUID();
    const filename = `${id}.jpg`;
    const outPath = join(uploadsDir, filename);
    await sharp(buffer)
      .rotate()
      .resize({ width: MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toFile(outPath);
    return { filename, originalName: sanitizeOriginalName(originalName) };
  }

  // Delete bulk images (Protected)
  router.delete('/bulk', requireAuth, (req, res) => {
    const ids = req.body?.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids array required' });
    }
    if (ids.length > 100) {
      return res.status(400).json({ error: 'Cannot delete more than 100 images at once' });
    }
    const numeric = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    if (numeric.length === 0) {
      return res.status(400).json({ error: 'No valid ids provided' });
    }

    const placeholders = numeric.map(() => '?').join(',');
    const rows = db.prepare(`SELECT id, album_id, filename FROM images WHERE id IN (${placeholders})`).all(...numeric);

    for (const row of rows) {
      deleteImageFile(row.filename);
      db.prepare('DELETE FROM images WHERE id = ?').run(row.id);
      refreshCoverIfNeeded(row.album_id, row.filename);
    }

    res.json({ deleted: rows.length });
  });

  // Upload images to an album (Protected)
  router.post('/upload', requireAuth, (req, res, next) => {
    upload.any()(req, res, (err) => {
      if (err) {
        return res.status(400).json({ error: err.message || 'File upload error' });
      }
      next();
    });
  }, async (req, res) => {
    const rawAlbumId = req.body?.albumId !== undefined ? req.body.albumId : req.body?.album_id;
    const albumId = Number(rawAlbumId);
    if (!Number.isInteger(albumId) || albumId <= 0) {
      return res.status(400).json({ error: 'Valid albumId is required' });
    }

    const album = db.prepare('SELECT id, cover_image FROM albums WHERE id = ?').get(albumId);
    if (!album) {
      return res.status(404).json({ error: 'Album not found' });
    }

    const files = req.files;
    if (!files || files.length === 0) {
      return res.status(400).json({ error: 'No image files provided' });
    }

    const inserted = [];
    try {
      for (const file of files) {
        if (!file.mimetype || !ALLOWED_MIME_TYPES.has(file.mimetype)) {
          continue;
        }
        let processed;
        try {
          processed = await processAndSave(file.buffer, file.originalname);
        } catch (imgErr) {
          console.warn('Image processing rejected corrupt file:', imgErr.message);
          continue;
        }

        const { filename, originalName } = processed;
        const info = db
          .prepare('INSERT INTO images (album_id, filename, original_name) VALUES (?, ?, ?)')
          .run(albumId, filename, originalName);

        if (!album.cover_image) {
          db.prepare('UPDATE albums SET cover_image = ? WHERE id = ?').run(filename, albumId);
          album.cover_image = filename;
        }

        inserted.push({
          id: info.lastInsertRowid,
          album_id: albumId,
          filename,
          original_name: originalName,
          url: `/uploads/${filename}`,
        });
      }
    } catch (err) {
      console.error('Error during image upload:', err.message);
      return res.status(500).json({ error: 'Failed to process images' });
    }

    if (inserted.length === 0) {
      return res.status(400).json({ error: 'None of the provided files were valid images' });
    }

    res.status(201).json({ images: inserted });
  });

  // Delete single image (Protected)
  router.delete('/:id', requireAuth, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid image ID' });
    }
    const row = db.prepare('SELECT id, album_id, filename FROM images WHERE id = ?').get(id);
    if (!row) {
      return res.status(404).json({ error: 'Image not found' });
    }
    deleteImageFile(row.filename);
    db.prepare('DELETE FROM images WHERE id = ?').run(id);
    refreshCoverIfNeeded(row.album_id, row.filename);
    res.status(204).send();
  });

  return router;
}
