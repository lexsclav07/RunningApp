/** @jest-environment node */
import { DatabaseSync } from 'node:sqlite';

test('node:sqlite available for persistence tests', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (x INTEGER)');
  db.prepare('INSERT INTO t VALUES (?)').run(1);
  expect(db.prepare('SELECT x FROM t').get()).toEqual({ x: 1 });
});
