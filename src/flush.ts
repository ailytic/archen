import {
  Database,
  Table,
  Record,
  Value,
  toDocument,
  Document
} from './database';
import { Accessor } from './accessor';
import { Row } from './engine';
import { encodeFilter } from './filter';

import DataLoader = require('dataloader');
import { SimpleField } from './model';

export enum FlushMethod {
  INSERT,
  UPDATE,
  DELETE
}

export class FlushState {
  method: FlushMethod = FlushMethod.INSERT;
  dirty: Set<string> = new Set();
  deleted: boolean = false;
  merged?: Record;
}

export const RecordProxy = {
  set: function(record: Record, name: string, value: any) {
    if (!/^__/.test(name)) {
      if (value === undefined) {
        throw Error(`Assigning undefined to ${name}`);
      }
      const model = record.__table.model;
      const field = model.field(name);
      if (!field) {
        throw Error(`Invalid field: ${model.name}.${name}`);
      }
      // throw TypeError(), RangeError(), etc
      record.__data[name] = value;
      record.__state.dirty.add(name);
    } else {
      record[name] = value;
    }
    return true;
  },

  get: function(record: Record, name: string) {
    if (typeof name === 'string' && !/^__/.test(name)) {
      if (typeof record[name] !== 'function') {
        const model = record.__table.model;
        const field = model.field(name);
        return record.__data[name];
      }
    }
    return record[name];
  }
};

class FlushContext {
  store: RecordStore;
  visited: Set<Record> = new Set();
  promises = [];

  constructor(store: RecordStore) {
    this.store = store;
  }
}

export class RecordStore {
  accessor: Accessor;
  inserter: DataLoader<Record, Record>;
  counter: number = 0;

  constructor(db: Database) {
    this.inserter = new DataLoader<Record, Record>((records: Record[]) =>
      Promise.all(records.map(record => _persist(this, record)))
    );
    this.accessor = new Accessor(db.schema, db.engine);
  }
}

function collectParentFields(
  record: Record,
  context: FlushContext,
  perfect: boolean
) {
  if (!record.__dirty() || context.visited.has(record)) return;

  context.visited.add(record);

  record.__state.dirty.forEach(key => {
    const value = record.__data[key];
    if (value instanceof Record) {
      if (value.__primaryKey() === undefined) {
        if (value.__flushable(perfect)) {
          // assert value.__state.method === FlushMethod.INSERT
          const promise = context.store.inserter.load(value);
          context.promises.push(promise);
        } else {
          collectParentFields(value, context, perfect);
        }
      }
    }
  });
}

export function flushRecord(record: Record): Promise<any> {
  const store = new RecordStore(record.__table.db);

  return new Promise((resolve, reject) => {
    function __resolve() {
      const context = new FlushContext(store);
      collectParentFields(record, context, true);
      if (context.promises.length > 0) {
        Promise.all(context.promises).then(() => __resolve());
      } else {
        if (record.__flushable(false)) {
          _persist(store, record).then(() => {
            if (!record.__dirty()) {
              resolve(record);
            } else {
              __resolve();
            }
          });
        } else {
          const context = new FlushContext(store);
          collectParentFields(record, context, false);
          if (context.promises.length > 0) {
            Promise.all(context.promises).then(() => __resolve());
          } else {
            reject(Error('Loops in record fields'));
          }
        }
      }
    }

    __resolve();
  });
}

/**
 * Flushes a *flushable* record to disk, updating its dirty fields or setting
 * __state.deleted to true after.
 *
 * @param record Record to be flushed to disk
 */
function _persist(store: RecordStore, record: Record): Promise<Record> {
  const method = record.__state.method;
  const model = record.__table.model;
  const filter = model.getUniqueFields(record.__data);

  if (method === FlushMethod.DELETE) {
    return record.__table.delete(filter).then(() => {
      record.__state.deleted = true;
      return record;
    });
  }

  const fields = record.__fields();

  if (method === FlushMethod.UPDATE) {
    return record.__table.update(fields, filter).then(affected => {
      if (affected > 0) {
        record.__remove_dirty(Object.keys(fields));
        return record;
      }
      throw Error(`Row does not exist`);
    });
  }

  return new Promise(resolve => {
    function _insert() {
      store.accessor.get(record.__table.model, filter).then(row => {
        if (row) {
          record.__remove_dirty(Object.keys(filter));
          if (!record.__dirty()) {
            resolve(record);
          } else {
            record.__table.update(fields, filter).then(() => {
              record.__remove_dirty(Object.keys(fields));
              if (record.__primaryKey() === undefined) {
                const value = row[model.primaryKey.fields[0].name];
                record.__setPrimaryKey(value as Value);
              }
              resolve(record);
            });
          }
        } else {
          record.__table
            .insert(fields)
            .then(id => {
              if (record.__primaryKey() === undefined) {
                record.__setPrimaryKey(id);
              }
              record.__remove_dirty(Object.keys(fields));
              record.__state.method = FlushMethod.UPDATE;
              resolve(record);
            })
            .catch(error => {
              _insert();
            });
        }
      });
    }
    _insert();
  });
}

const DEFAULT_OPTIONS = {
  separator: '-'
};

export function flushTable(table: Table, options?): Promise<any> {
  options = Object.assign({}, options, DEFAULT_OPTIONS);

  mergeRecords(table, options);

  const filter = [];

  for (const record of table.recordList) {
    if (record.__dirty() && record.__flushable()) {
      filter.push(record.__uniqueFields());
    }
  }

  if (filter.length === 0) return Promise.resolve();

  const dialect = table.db.engine;
  const model = table.model;

  function _select() {
    const fields = model.fields.filter(field => field.uniqueKey);
    const columns = fields.map(field => (field as SimpleField).column.name);
    const expression = columns.map(dialect.escapeId).join(',');
    const from = dialect.escapeId(model.table.name);
    const where = encodeFilter(filter, table.model, dialect);
    const sql = `select ${columns.join(',')} from ${from} where ${where}`;
    return table.db.engine.query(sql).then(rows => {
      rows = rows.map(row => toDocument(row, table.model));
      for (const record of table.recordList) {
        if (!record.__dirty()) continue;
        for (const row of rows) {
          if (!record.__match(row)) continue;
          if (!record.__primaryKey()) {
            const value = row[model.keyField().name];
            record.__setPrimaryKey(value);
          }
          for (const name in row) {
            if (!record.__state.dirty.has(name)) continue;
            const lhs = model.valueOf(record.__data[name], name);
            const rhs = model.valueOf(row[name] as Value, name);
            if (lhs === rhs) {
              record.__state.dirty.delete(name);
            }
          }
          if (record.__dirty()) {
            if (record.__state.method === FlushMethod.INSERT) {
              record.__state.method = FlushMethod.UPDATE;
            }
          }
        }
      }
      return table.recordList;
    });
  }

  function _insert() {
    const fields = model.fields.filter(field => field instanceof SimpleField);
    const names = fields.map(field => (field as SimpleField).column.name);
    const columns = names.map(dialect.escapeId).join(',');
    const into = dialect.escapeId(model.table.name);

    const values = [];
    for (const record of table.recordList) {
      if (!record.__dirty() || !record.__flushable()) continue;
      if (record.__state.method !== FlushMethod.INSERT) continue;
      const entry = fields.reduce((values, field) => {
        const value = record.__getValue(field.name);
        values.push(table.escapeValue(field as SimpleField, value));
        return values;
      }, []);
      values.push(`(${entry})`);
    }

    // NOTE: Only works for MySQL which accepts null for auto increment keys
    const sql = `insert into ${into} (${columns}) values ${values.join(', ')}`;
    return table.db.engine.query(sql);
  }

  // TODO:
  // 1. Honour merged when checking parent value
  // 2. Updated merged records after inserting
  return _select()
    .then(() => _insert())
    .then(() => _select());
}

function mergeRecords(table: Table, options) {
  const model = table.model;

  const map = model.uniqueKeys.reduce((map, uc) => {
    map[uc.name()] = {};
    return map;
  }, {});

  for (const record of table.recordList) {
    for (const uc of model.uniqueKeys) {
      const value = record.__valueOf(uc, options.separator);
      if (value === undefined) continue;
      const existing = map[uc.name()][value];
      if (existing) {
        if (!record.__state.merged) {
          record.__state.merged = existing;
        } else if (record.__state.merged !== existing) {
          throw Error(`Could not merge into different records`);
        }
      } else {
        map[uc.name()][value] = record;
      }
    }
    if (record.__state.merged) {
      record.__merge();
    }
  }
}
