import { Accessor, AccessorOptions } from './accessor';
import { GraphQLSchemaBuilder, SchemaBuilderOptions } from './schema';

import {
  Schema,
  SchemaInfo,
  SchemaConfig,
  Database,
  ConnectionPool,
} from '@ailytic/sqlit';

export interface ArchenConfig {
  pool: ConnectionPool;
  schemaInfo: SchemaInfo;
  schema?: SchemaConfig;
  accessor?: AccessorOptions;
  graphql?: SchemaBuilderOptions;
}

export class Archen {
  config: ArchenConfig;
  schema: Schema;
  graphql: GraphQLSchemaBuilder;

  constructor(config: ArchenConfig) {
    this.config = { ...config };
    this.buildGraphQLSchema();
  }

  getAccessor(): Accessor {
    const database = new Database(
      this.config.pool,
      this.schema
    );
    return new Accessor(database, this.config.accessor);
  }

  private buildGraphQLSchema() {
    this.schema = new Schema(
      this.config.schemaInfo,
      this.config.schema
    );
    this.graphql = new GraphQLSchemaBuilder(this.schema, this.config.graphql);
  }
}

export { Accessor };
