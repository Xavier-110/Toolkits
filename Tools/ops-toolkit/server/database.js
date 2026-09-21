import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { emptyState } from '../src/store.js';

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), {recursive:true});
  const db = new DatabaseSync(filename, {timeout:5000});
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      passwordHash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','operate','readonly')),
      enabled INTEGER NOT NULL DEFAULT 1, mustChangePassword INTEGER NOT NULL DEFAULT 1,
      createdAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      digest TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id),
      csrf TEXT NOT NULL, expiresAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);`);
  db.prepare('INSERT OR IGNORE INTO workspace VALUES (1, ?)').run(JSON.stringify(emptyState()));
  return db;
}
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function fail(status, message) { throw Object.assign(new Error(message), {status}); }
