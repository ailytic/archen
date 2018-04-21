import { Connection, Escape, Row } from './connection';
import { getInformationSchema } from './information_schema';

function createConnection(engine: string = 'mysql', options: any = {}) {
  if (engine === 'mysql') {
    return require('./mysql').default(options);
  }
}

export { Connection, Escape, Row, createConnection, getInformationSchema };
