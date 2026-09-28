import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { unlinkSync, existsSync } from 'fs';
import { join, basename } from 'path';

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function uniqueSlug(db, base, excludeId = null) {
  let slug = base || 'album';
  let n = 0;
  while (true) {
    const row = excludeId
      ? db.prepare('SELECT id FROM albums WHERE slug = ? AND id != ?').get(slug, excludeId)
      : db.prepare('SELECT id FROM albums WHERE slug = ?').get(slug);
    if (!row) return slug;
    n += 1;
    slug = `${base}-${n}`;
  }
}

// Calculate the 1-based depth of an album (1 = Root, 2 = Sub, 3 = Sub-sub, 4 = Max level)
function getAlbumDepth(db, albumId, parentId = undefined, parentQueryStmt = null) {
  if (parentId === null) return 1;
  let depth = 1;
  let currentId = parentId !== undefined ? parentId : albumId;
  const visited = new Set();

  if (parentId !== undefined) {
    depth = 2;
  }

  const stmt = parentQueryStmt || db.prepare('SELECT parent_id FROM albums WHERE id = ?');

  while (currentId) {
    if (visited.has(currentId)) break; // cycle protection
    visited.add(currentId);

    const row = stmt.get(currentId);
    if (!row || row.parent_id === null || row.parent_id === undefined) {
      break;
    }
    depth += 1;
    currentId = row.parent_id;
  }
  return depth;
}

// Build breadcrumbs path from root to current album
function getBreadcrumbs(db, albumId, parentQueryStmt = null) {
  const breadcrumbs = [];
  let currentId = albumId;
  const visited = new Set();
  const selectStmt = db.prepare('SELECT id, name, slug, parent_id FROM albums WHERE id = ?');

  while (currentId) {
    if (visited.has(currentId)) break;
    visited.add(currentId);

    const row = selectStmt.get(currentId);
    if (!row) break;
    const depth = getAlbumDepth(db, row.id, row.parent_id, parentQueryStmt);
    breadcrumbs.unshift({
      id: row.id,
      name: row.name,
      slug: row.slug,
      depth
    });
    currentId = row.parent_id;
  }
  return breadcrumbs;
}

// Resolve cover URL: direct photo cover, or fallback to first child album cover/photo
function getEffectiveCoverUrl(db, album, firstPhotoStmt = null, childrenCoverStmt = null) {
  if (album.cover_image) {
    return `/uploads/${album.cover_image}`;
  }
  const photoStmt = firstPhotoStmt || db.prepare('SELECT filename FROM images WHERE album_id = ? ORDER BY id ASC LIMIT 1');
  // Try direct photos first
  const firstPhoto = photoStmt.get(album.id);
  if (firstPhoto && firstPhoto.filename) {
    return `/uploads/${firstPhoto.filename}`;
  }
  // Look into direct sub-albums
  const childStmt = childrenCoverStmt || db.prepare('SELECT id, cover_image FROM albums WHERE parent_id = ? ORDER BY id ASC');
  const children = childStmt.all(album.id);
  for (const child of children) {
    if (child.cover_image) {
      return `/uploads/${child.cover_image}`;
    }
    const childPhoto = photoStmt.get(child.id);
    if (childPhoto && childPhoto.filename) {
      return `/uploads/${childPhoto.filename}`;
    }
  }
  return null;
}

// Collect all descendant album IDs recursively
function getAllDescendantAlbumIds(db, rootId) {
  const ids = [rootId];
  const queue = [rootId];
  const visited = new Set([rootId]);
  const childQuery = db.prepare('SELECT id FROM albums WHERE parent_id = ?');

  while (queue.length > 0) {
    const curId = queue.shift();
    const children = childQuery.all(curId);
    for (const child of children) {
      if (!visited.has(child.id)) {
        visited.add(child.id);
        ids.push(child.id);
        queue.push(child.id);
      }
    }
  }
  return ids;
}

export function createAlbumsRouter(db, uploadsDir) {
  const router = Router();

  // Reusable prepared statements for rapid repeated queries
  const photoCountStmt = db.prepare('SELECT COUNT(*) as count FROM images WHERE album_id = ?');
  const subCountStmt = db.prepare('SELECT COUNT(*) as count FROM albums WHERE parent_id = ?');
  const parentDepthStmt = db.prepare('SELECT parent_id FROM albums WHERE id = ?');
  const firstPhotoStmt = db.prepare('SELECT filename FROM images WHERE album_id = ? ORDER BY id ASC LIMIT 1');
  const childrenCoverStmt = db.prepare('SELECT id, cover_image FROM albums WHERE parent_id = ? ORDER BY id ASC');

  // Helper to format an album row
  function formatAlbumRow(a) {
    const photoCountRow = photoCountStmt.get(a.id);
    const subCountRow = subCountStmt.get(a.id);
    const depth = getAlbumDepth(db, a.id, a.parent_id, parentDepthStmt);
    return {
      id: a.id,
      name: a.name,
      slug: a.slug,
      description: a.description || '',
      cover_image: a.cover_image || null,
      coverUrl: getEffectiveCoverUrl(db, a, firstPhotoStmt, childrenCoverStmt),
      parent_id: a.parent_id || null,
      depth,
      photoCount: photoCountRow ? photoCountRow.count : 0,
      subAlbumCount: subCountRow ? subCountRow.count : 0,
      canAddSubAlbum: depth < 4,
      created_at: a.created_at
    };
  }

  // GET /api/albums - List albums
  // Options:
  // - ?all=true -> returns all albums in the database
  // - ?parentId=<id> -> returns sub-albums of specific parent
  // - default (no params or parentId=null/root) -> returns Level 1 root albums
  router.get('/', (req, res) => {
    try {
      const { parentId, all } = req.query;
      let rows = [];

      if (all === 'true') {
        rows = db.prepare('SELECT id, name, slug, description, cover_image, parent_id, created_at FROM albums ORDER BY id ASC').all();
      } else if (parentId !== undefined && parentId !== 'null' && parentId !== 'root') {
        const pId = Number(parentId);
        rows = db.prepare('SELECT id, name, slug, description, cover_image, parent_id, created_at FROM albums WHERE parent_id = ? ORDER BY id ASC').all(pId);
      } else {
        // Root albums (Level 1)
        rows = db.prepare('SELECT id, name, slug, description, cover_image, parent_id, created_at FROM albums WHERE parent_id IS NULL ORDER BY id ASC').all();
      }

      res.json(rows.map(formatAlbumRow));
    } catch (error) {
      console.error('Error fetching albums:', error);
      res.status(500).json({ error: 'Failed to fetch albums' });
    }
  });

  // GET /api/albums/:slugOrId - Get single album with full details (sub-albums, photos, breadcrumbs, depth)
  router.get('/:slugOrId', (req, res) => {
    try {
      const param = req.params.slugOrId;
      let album = db.prepare('SELECT id, name, slug, description, cover_image, parent_id, created_at FROM albums WHERE slug = ?').get(param);

      if (!album && /^\d+$/.test(param)) {
        album = db.prepare('SELECT id, name, slug, description, cover_image, parent_id, created_at FROM albums WHERE id = ?').get(Number(param));
      }

      if (!album) {
        return res.status(404).json({ error: 'Album not found' });
      }

      const depth = getAlbumDepth(db, album.id);
      const breadcrumbs = getBreadcrumbs(db, album.id);

      // Immediate child sub-albums
      const subAlbumRows = db.prepare('SELECT id, name, slug, description, cover_image, parent_id, created_at FROM albums WHERE parent_id = ? ORDER BY id ASC').all(album.id);
      const subAlbums = subAlbumRows.map(formatAlbumRow);

      // Direct photos
      const imageRows = db.prepare('SELECT id, album_id, filename, original_name, created_at FROM images WHERE album_id = ? ORDER BY created_at DESC').all(album.id);
      const images = imageRows.map(img => ({
        ...img,
        url: `/uploads/${img.filename}`
      }));

      // Total descendant photos count
      const allSubIds = getAllDescendantAlbumIds(db, album.id);
      const placeholders = allSubIds.map(() => '?').join(',');
      const totalPhotosRow = db.prepare(`SELECT COUNT(*) as count FROM images WHERE album_id IN (${placeholders})`).get(...allSubIds);

      res.json({
        id: album.id,
        name: album.name,
        slug: album.slug,
        description: album.description || '',
        cover_image: album.cover_image || null,
        coverUrl: getEffectiveCoverUrl(db, album),
        parent_id: album.parent_id || null,
        depth,
        canAddSubAlbum: depth < 4,
        breadcrumbs,
        photoCount: images.length,
        subAlbumCount: subAlbums.length,
        totalPhotoCount: totalPhotosRow ? totalPhotosRow.count : images.length,
        subAlbums,
        images,
        created_at: album.created_at
      });
    } catch (error) {
      console.error('Error fetching album detail:', error);
      res.status(500).json({ error: 'Failed to fetch album details' });
    }
  });

  // GET /api/albums/:id/delete-summary - Summary of albums & photos that will be deleted
  router.get('/:id/delete-summary', requireAuth, (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Invalid album ID' });

      const album = db.prepare('SELECT id, name FROM albums WHERE id = ?').get(id);
      if (!album) return res.status(404).json({ error: 'Album not found' });

      const allIds = getAllDescendantAlbumIds(db, id);
      const subAlbumCount = allIds.length - 1; // exclude self

      const placeholders = allIds.map(() => '?').join(',');
      const countRow = db.prepare(`SELECT COUNT(*) as count FROM images WHERE album_id IN (${placeholders})`).get(...allIds);
      const totalPhotos = countRow ? countRow.count : 0;

      res.json({
        id: album.id,
        name: album.name,
        subAlbumCount,
        totalPhotoCount: totalPhotos
      });
    } catch (error) {
      console.error('Error getting delete summary:', error.message);
      res.status(500).json({ error: 'Failed to calculate delete summary' });
    }
  });

  // POST /api/albums - Create album or sub-album (Protected)
  router.post('/', requireAuth, (req, res) => {
    try {
      const { name, description } = req.body || {};
      const parentId = req.body?.parentId !== undefined ? req.body.parentId : req.body?.parent_id;

      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'Album name is required' });
      }

      const cleanName = name.trim();
      if (cleanName.length > 100) {
        return res.status(400).json({ error: 'Album name must be 100 characters or fewer' });
      }

      let cleanDescription = null;
      if (description !== undefined && description !== null) {
        if (typeof description !== 'string') {
          return res.status(400).json({ error: 'Description must be a string' });
        }
        cleanDescription = description.trim();
        if (cleanDescription.length > 1000) {
          return res.status(400).json({ error: 'Description must be 1000 characters or fewer' });
        }
      }

      let parsedParentId = null;
      let targetDepth = 1;

      if (parentId !== undefined && parentId !== null && parentId !== '' && parentId !== 'null' && parentId !== 'root') {
        parsedParentId = Number(parentId);
        if (!Number.isInteger(parsedParentId) || parsedParentId <= 0) {
          return res.status(400).json({ error: 'Invalid parent album ID' });
        }

        const parentAlbum = db.prepare('SELECT id, name FROM albums WHERE id = ?').get(parsedParentId);
        if (!parentAlbum) {
          return res.status(404).json({ error: 'Parent album not found' });
        }

        const parentDepth = getAlbumDepth(db, parsedParentId);
        targetDepth = parentDepth + 1;

        // Depth validation: Maximum 4 levels allowed
        if (targetDepth > 4) {
          return res.status(400).json({
            error: 'Maximum album depth reached. Sub-albums can only be nested up to 4 levels (Level 4 cannot contain sub-albums).'
          });
        }
      }

      const base = slugify(cleanName);
      const slug = uniqueSlug(db, base);

      const info = db
        .prepare('INSERT INTO albums (name, slug, description, parent_id) VALUES (?, ?, ?, ?)')
        .run(cleanName, slug, cleanDescription, parsedParentId);

      const newAlbum = db.prepare('SELECT id, name, slug, description, cover_image, parent_id, created_at FROM albums WHERE id = ?').get(info.lastInsertRowid);

      res.status(201).json(formatAlbumRow(newAlbum));
    } catch (e) {
      console.error('Error creating album:', e.message);
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || (e.message && e.message.includes('UNIQUE'))) {
        return res.status(409).json({ error: 'An album with this slug already exists' });
      }
      res.status(500).json({ error: 'Failed to create album' });
    }
  });

  // PUT /api/albums/:id - Rename / edit album (Protected)
  router.put('/:id', requireAuth, (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid album ID' });
      }

      const existing = db.prepare('SELECT id, name, slug, description, parent_id FROM albums WHERE id = ?').get(id);
      if (!existing) {
        return res.status(404).json({ error: 'Album not found' });
      }

      const { name, description } = req.body || {};
      if (name === undefined && description === undefined) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      let cleanName = existing.name;
      let cleanSlug = existing.slug;
      if (name !== undefined) {
        if (typeof name !== 'string' || !name.trim()) {
          return res.status(400).json({ error: 'Album name cannot be empty' });
        }
        const trimmed = name.trim();
        if (trimmed.length > 100) {
          return res.status(400).json({ error: 'Album name must be 100 characters or fewer' });
        }
        cleanName = trimmed;
        const base = slugify(trimmed);
        cleanSlug = uniqueSlug(db, base, id);
      }

      let cleanDesc = existing.description;
      if (description !== undefined) {
        if (description !== null && typeof description !== 'string') {
          return res.status(400).json({ error: 'Description must be a string' });
        }
        cleanDesc = description ? description.trim() : null;
        if (cleanDesc && cleanDesc.length > 1000) {
          return res.status(400).json({ error: 'Description must be 1000 characters or fewer' });
        }
      }

      db.prepare('UPDATE albums SET name = ?, slug = ?, description = ? WHERE id = ?').run(
        cleanName,
        cleanSlug,
        cleanDesc,
        id
      );

      const updated = db.prepare('SELECT id, name, slug, description, cover_image, parent_id, created_at FROM albums WHERE id = ?').get(id);
      res.json(formatAlbumRow(updated));
    } catch (e) {
      console.error('Error updating album:', e.message);
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || (e.message && e.message.includes('UNIQUE'))) {
        return res.status(409).json({ error: 'An album with this name or slug already exists' });
      }
      res.status(500).json({ error: 'Failed to update album' });
    }
  });

  // DELETE /api/albums/:id - Cascading delete with physical file cleanup (Protected)
  router.delete('/:id', requireAuth, (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'Invalid album ID' });
      }

      const album = db.prepare('SELECT id, name FROM albums WHERE id = ?').get(id);
      if (!album) {
        return res.status(404).json({ error: 'Album not found' });
      }

      // Collect all descendant albums including this one
      const allIds = getAllDescendantAlbumIds(db, id);
      const placeholders = allIds.map(() => '?').join(',');

      // Find all image files associated with any of these albums
      const images = db.prepare(`SELECT filename FROM images WHERE album_id IN (${placeholders})`).all(...allIds);
      for (const img of images) {
        if (img.filename && typeof img.filename === 'string') {
          const safeName = basename(img.filename);
          const filePath = join(uploadsDir, safeName);
          if (existsSync(filePath)) {
            try {
              unlinkSync(filePath);
            } catch (err) {
              console.warn('Could not unlink image file:', safeName, err.message);
            }
          }
        }
      }

      // Also clean up any direct cover images
      const coverRows = db.prepare(`SELECT cover_image FROM albums WHERE id IN (${placeholders}) AND cover_image IS NOT NULL`).all(...allIds);
      for (const row of coverRows) {
        if (row.cover_image && typeof row.cover_image === 'string') {
          const safeCover = basename(row.cover_image);
          const coverPath = join(uploadsDir, safeCover);
          if (existsSync(coverPath)) {
            try {
              unlinkSync(coverPath);
            } catch (err) {
              console.warn('Could not unlink cover image file:', safeCover, err.message);
            }
          }
        }
      }

      // Delete albums (foreign keys will cascade to images table)
      db.prepare(`DELETE FROM images WHERE album_id IN (${placeholders})`).run(...allIds);
      const info = db.prepare(`DELETE FROM albums WHERE id IN (${placeholders})`).run(...allIds);

      // Refresh parent cover if it was pointing to a deleted image
      if (album.parent_id) {
        const parentAlbum = db.prepare('SELECT id, cover_image FROM albums WHERE id = ?').get(album.parent_id);
        if (parentAlbum && parentAlbum.cover_image) {
          const wasDeleted = images.some((img) => img.filename === parentAlbum.cover_image) ||
                             coverRows.some((row) => row.cover_image === parentAlbum.cover_image);
          if (wasDeleted) {
            const nextPhoto = db.prepare('SELECT filename FROM images WHERE album_id = ? ORDER BY created_at DESC LIMIT 1').get(album.parent_id);
            db.prepare('UPDATE albums SET cover_image = ? WHERE id = ?').run(nextPhoto ? nextPhoto.filename : null, album.parent_id);
          }
        }
      }

      res.json({ ok: true, deletedAlbumCount: allIds.length });
    } catch (e) {
      console.error('Error deleting album:', e.message);
      res.status(500).json({ error: 'Failed to delete album' });
    }
  });

  return router;
}
