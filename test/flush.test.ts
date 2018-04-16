import { Schema } from '../src/model';
import { Database, Table, Record } from '../src/database';

import helper = require('./helper');
import { FlushMethod } from '../src/flush';

const NAME = 'flush';

beforeAll(() => helper.createDatabase(NAME));
afterAll(() => helper.dropDatabase(NAME));

test('append', () => {
  const schema = new Schema(helper.getExampleData());
  const db = new Database(schema);
  const user = db.append('user', { email: 'user@example.com' });
  expect(user instanceof Record).toBe(true);
  expect(db.table('user').recordList.length).toBe(1);
  user.status = 200;
  expect(user.status).toBe(200);
  expect(() => (user.whatever = 200)).toThrow();
});

test('append #2', () => {
  const schema = new Schema(helper.getExampleData());
  const db = new Database(schema);
  const user = db.User({ email: 'user@example.com' });
  expect(user instanceof Record).toBe(true);
  expect(user.email).toBe('user@example.com');
  expect(user.get('email')).toBe('user@example.com');
  expect(user.__table).toBe(db.table('user'));
  expect(db.table('user').recordList.length).toBe(1);
});

test('delete', async done => {
  const schema = new Schema(helper.getExampleData());
  const db = helper.connectToDatabase(NAME, schema);
  const table = db.table('user');
  const id = await table.insert({ email: 'deleted@example.com' });
  const row = await table.get({ id });
  expect(row.email).toBe('deleted@example.com');
  const record = db.User({ email: 'deleted@example.com' });
  const deleted = record.delete();
  record.delete().then(async () => {
    expect(await table.get({ id })).toBe(undefined);
    done();
  });
});

test('update', async done => {
  const schema = new Schema(helper.getExampleData());
  const db = helper.connectToDatabase(NAME, schema);
  const table = db.table('user');
  const id = await table.insert({ email: 'updated@example.com', status: 100 });
  const row = await table.get({ id });
  expect(row.status).toBe(100);
  const user = db.User({ email: 'updated@example.com' });
  await user.update({ status: 200 });
  expect((await table.get({ id })).status).toBe(200);
  done();
});

test('save #1', async done => {
  const schema = new Schema(helper.getExampleData());
  const db = helper.connectToDatabase(NAME, schema);
  const user = db.User({ email: 'saved01@example.com' });
  user.save().then(async row => {
    expect(row.email).toBe('saved01@example.com');
    const user = await db.table('user').get({ email: 'saved01@example.com' });
    expect(user.id).toBe(row.id);
    done();
  });
});