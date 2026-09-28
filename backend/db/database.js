import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const dataDir = join(rootDir, 'data');
const dbPath = join(dataDir, 'app.db');

let sqlJsFactory = null;

async function getSqlJs() {
  if (!sqlJsFactory) {
    sqlJsFactory = await initSqlJs();
  }
  return sqlJsFactory;
}

function persist(db) {
  const data = db.export();
  writeFileSync(dbPath, Buffer.from(data));
}

function normalizeParams(params) {
  if (params.length === 0) return [];
  if (params.length === 1 && Array.isArray(params[0])) return params[0];
  return [...params];
}

function wrap(db, persistFn) {
  return {
    prepare(sql) {
      return {
        run(...params) {
          const flat = normalizeParams(params);
          db.run(sql, flat);
          const lastInsertRowid = Number(db.exec('SELECT last_insert_rowid()')[0].values[0][0]);
          const changes = Number(db.exec('SELECT changes()')[0].values[0][0]);
          persistFn();
          return { lastInsertRowid, changes };
        },
        get(...params) {
          const flat = normalizeParams(params);
          const stmt = db.prepare(sql);
          stmt.bind(flat);
          if (!stmt.step()) {
            stmt.free();
            return undefined;
          }
          const row = stmt.getAsObject();
          stmt.free();
          return row;
        },
        all(...params) {
          const flat = normalizeParams(params);
          const stmt = db.prepare(sql);
          stmt.bind(flat);
          const rows = [];
          while (stmt.step()) {
            rows.push(stmt.getAsObject());
          }
          stmt.free();
          return rows;
        },
      };
    },
  };
}

// Fixed admin credentials given to the client.
// Pre-computed bcrypt hash (cost 10) so the plaintext password never appears in the codebase.
const DEFAULT_ADMIN_USERNAME = 'HaristaInteriors';
const DEFAULT_ADMIN_PASSWORD_HASH = '$2b$10$5yelh0Zglr9LATEtCfBNnuH9Hyc0CuK3LONc2SwEDsfRdFweDDtpO';

function seedIfNeeded(dbWrapped) {
  const row = dbWrapped.prepare('SELECT COUNT(*) as c FROM admin').get();
  const adminCount = row ? row.c : 0;
  if (adminCount === 0) {
    const username = process.env.ADMIN_USERNAME || DEFAULT_ADMIN_USERNAME;
    let passwordHash = DEFAULT_ADMIN_PASSWORD_HASH;

    if (process.env.ADMIN_PASSWORD) {
      passwordHash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
    } else if (process.env.ADMIN_PASSWORD_HASH) {
      passwordHash = process.env.ADMIN_PASSWORD_HASH;
    }

    dbWrapped.prepare('INSERT INTO admin (username, password) VALUES (?, ?)').run(username, passwordHash);
    console.log(`Seeded admin user: ${username}`);
  }

  // Seed default Harista albums
  const albumRows = [
    { name: 'Modular Kitchens', slug: 'modular-kitchens', description: 'Intelligent layouts, seamless storage, and tailored finishes.' },
    { name: 'Home Interiors', slug: 'home-interiors', description: 'Complete residential spaces designed for modern living.' },
    { name: 'Office & Commercial', slug: 'office-commercial', description: 'Bespoke corporate, retail, and commercial interior solutions.' },
    { name: 'Wardrobes', slug: 'wardrobes', description: 'Custom modular sliding and hinged wardrobe systems.' },
    { name: 'Beds', slug: 'beds', description: 'Handcrafted luxury bedroom designs and beds.' },
    { name: 'TV Units', slug: 'tv-units', description: 'Minimalist media consoles and entertainment walls.' },
  ];

  const insertAlbum = dbWrapped.prepare(
    'INSERT OR IGNORE INTO albums (name, slug, description) VALUES (?, ?, ?)'
  );
  for (const a of albumRows) {
    insertAlbum.run(a.name, a.slug, a.description);
  }
}

export async function getDb() {
  const SQL = await getSqlJs();
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  let db;
  if (existsSync(dbPath)) {
    const fileBuffer = readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');

  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  // Safe migration for existing databases: check and add parent_id if missing
  try {
    const tableInfo = db.exec("PRAGMA table_info(albums)");
    if (tableInfo.length > 0 && tableInfo[0].values) {
      const columns = tableInfo[0].values.map(col => col[1]);
      if (!columns.includes('parent_id')) {
        db.run('ALTER TABLE albums ADD COLUMN parent_id INTEGER DEFAULT NULL REFERENCES albums(id) ON DELETE CASCADE');
        console.log('Migrated albums table: added parent_id column successfully.');
      }
    }
  } catch (migErr) {
    console.warn('Migration check warning:', migErr.message);
  }

  const persistFn = () => persist(db);
  const wrapped = wrap(db, persistFn);
  seedIfNeeded(wrapped);
  persistFn();

  return wrapped;
}
