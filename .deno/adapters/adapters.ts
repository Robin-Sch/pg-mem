import { LibAdapters, IMemoryDb, NotSupported, QueryResult, SlonikAdapterOptions, BindServerOptions, BindServerResult } from '../interfaces.ts';
import lru from 'https://deno.land/x/lru_cache@6.0.0-deno.4/mod.ts';
import { compareVersions, delay, doRequire, timeoutOrImmediate } from '../utils.ts';
import { toLiteral } from '../misc/pg-utils.ts';
import { _IDb, _IType } from '../interfaces-private.ts';
import { TYPE_SYMBOL } from '../execution/select.ts';
import { ArrayType } from '../datatypes/index.ts';
import { CustomEnumType } from '../datatypes/t-custom-enum.ts';
import { bindPgServer, socketAdapter } from './pg-socket-adapter.ts';


export function replaceQueryArgs$(this: void, sql: string, values: any[]) {
    return sql.replace(/\$(\d+)/g, (str: any, istr: any) => {
        const i = Number.parseInt(istr);
        if (i > values.length) {
            throw new Error('Unmatched parameter in query ' + str);
        }
        const val = values[i - 1];
        return toLiteral(val);
    });
}


export class Adapters implements LibAdapters {
    private _mikroPatched?: boolean;

    constructor(private db: _IDb) {
    }

    createPg(queryLatency?: number): { Pool: any; Client: any } {
        const that = this;
        // https://node-postgres.com/features/queries
        interface PgQuery {
            text: string;
            values?: any[];
            rowMode?: 'array';
            types?: any;
        }
        class MemPg {

            connection = this;

            on() {
                // nop
            }

            release() {
            }

            removeListener() {
            }

            once(what: string, handler: () => void) {
                if (what === 'connect') {
                    timeoutOrImmediate(handler, queryLatency ?? 0);
                }
            }

            end(callback: any) {
                if (callback) {
                    callback();
                    return null;
                } else {
                    return Promise.resolve();
                }
            }

            connect(callback: any) {
                if (callback) {
                    callback(null, this, () => { });
                    return null;
                } else {
                    return Promise.resolve(this);
                }
            }
            query(query: any, valuesOrCallback: any, callback: any) {
                let values: any = null;
                if (Array.isArray(valuesOrCallback)) {
                    values = valuesOrCallback;
                }
                if (callback == null && typeof valuesOrCallback === 'function') {
                    callback = valuesOrCallback;
                }

                // adapt results

                const pgquery = this.adaptQuery(query, values);
                try {
                    const result = this.adaptResults(query, that.db.public.query(pgquery.text));
                    if (callback) {
                        timeoutOrImmediate(() => callback(null, result), queryLatency ?? 0);
                        return null;
                    } else {
                        return new Promise(res => timeoutOrImmediate(() => res(result), queryLatency ?? 0));
                    }
                } catch (e) {
                    if (callback) {
                        timeoutOrImmediate(() => callback(e), queryLatency ?? 0);
                        return null;
                    } else {
                        return new Promise((_, rej) => timeoutOrImmediate(() => rej(e), queryLatency ?? 0));
                    }
                }
            }

            private adaptResults(query: PgQuery, res: QueryResult) {
                if (query.rowMode) {
                    throw new NotSupported('pg rowMode');
                }
                return {
                    ...res,
                    // clone rows to avoid leaking symbols
                    rows: res.rows.map(row => {
                        const rowCopy: any = {};
                        // copy all
                        for (const [k, v] of Object.entries(row)) {
                            rowCopy[k] = v;
                        }
                        // ...but amend fields based on their types
                        for (const f of res.fields) {
                            const type = (f as any)[TYPE_SYMBOL] as _IType;
                            const value = row[f.name];
                            // enum arrays are returned as strings... see #224
                            if (type instanceof ArrayType && type.of instanceof CustomEnumType && Array.isArray(value)) {
                                rowCopy[f.name] = `{${value.join(',')}}`;
                            }
                        }
                        return rowCopy;
                    }),
                    get fields() {
                        // to implement if needed ? (never seen a lib that uses it)
                        return [];
                    }
                };
            }

            private adaptQuery(query: string | PgQuery, values: any): PgQuery {
                if (typeof query === 'string') {
                    query = {
                        text: query,
                        values,
                    };
                } else {
                    // clean copy to avoid mutating things outside our scope
                    query = { ...query, values: query.values || values };
                }
                if (!query.values?.length) {
                    return query;
                }

                if (query.types?.getTypeParser) {
                    throw new NotSupported('getTypeParser is not supported');
                }

                // console.log(query);
                // console.log('\n');

                query.text = replaceQueryArgs$(query.text, query.values);
                return query;
            }
        }
        return {
            Pool: MemPg,
            Client: MemPg,
        };
    }

    /**
     * @deprecated Use `createTypeormDataSource` instead.
     */
    createTypeormConnection(postgresOptions: any, queryLatency?: number) {
        const that = this;
        (postgresOptions as any).postgres = that.createPg(queryLatency);
        if (postgresOptions?.type !== 'postgres') {
            throw new NotSupported('Only postgres supported, found ' + postgresOptions?.type ?? '<null>')
        }

        const { getConnectionManager } = doRequire('typeorm')
        const created = getConnectionManager().create(postgresOptions);
        created.driver.postgres = that.createPg(queryLatency);
        return created.connect();
    }

    createTypeormDataSource(postgresOptions: any, queryLatency?: number) {
        const that = this;
        (postgresOptions as any).postgres = that.createPg(queryLatency);
        if (postgresOptions?.type !== 'postgres') {
            throw new NotSupported('Only postgres supported, found ' + postgresOptions?.type ?? '<null>')
        }

        const nr = doRequire('typeorm');
        const { DataSource } = nr;
        const created = new DataSource(postgresOptions);
        created.driver.postgres = that.createPg(queryLatency);
        return created;
    }

    createSlonik(opts?: SlonikAdapterOptions) {
        const slonik = doRequire('slonik');
        if (typeof slonik.createMockPool !== 'function') {
            // see https://github.com/gajus/slonik/blob/main/packages/slonik/src/factories/createPool.ts
            // and @slonik/pg-driver https://github.com/gajus/slonik/blob/main/packages/pg-driver/src/factories/createPgDriverFactory.ts
            const { createDriverFactory } = doRequire('@slonik/driver');
            const createResultParserInterceptor = () => {
                return {
                    transformRow: async (executionContext: any, actualQuery: any, row: any) => {
                        const { resultParser } = executionContext;
                        if (!resultParser) {
                            return row;
                        }
                        // It is recommended (but not required) to parse async to avoid blocking the event loop during validation
                        const validationResult = await resultParser.safeParseAsync(row);

                        if (!validationResult.success) {
                            throw new slonik.SchemaValidationError(
                                actualQuery,
                                row,
                                validationResult.error.issues
                            );
                        }

                        return validationResult.data;
                    },
                };
            };
            return slonik.createPool('', {
                ...opts?.createPoolOptions ?? {},
                ...opts?.zodValidation ? { interceptors: [createResultParserInterceptor(), ...opts?.createPoolOptions?.interceptors ?? []] } : {},
                // driverFactory:  factory,
                driverFactory: createDriverFactory(() => {
                    return {
                        createPoolClient: async () => {
                            let connected = false;
                            return {
                                connect: async () => {
                                    await delay(opts?.queryLatency ?? 0);
                                    connected = true;
                                },
                                end: async () => {
                                    await delay(opts?.queryLatency ?? 0);
                                    connected = false;
                                },
                                query: async (sql: string, args: any[]) => {
                                    if (!connected) {
                                        throw new Error('your fake pg pool is not connected');
                                    }
                                    if (sql === 'DISCARD ALL') {
                                        return { rows: [] };
                                    }
                                    await delay(opts?.queryLatency ?? 0);
                                    const formatted = replaceQueryArgs$(sql, args);
                                    const result = this.db.public.query(formatted);
                                    return result;
                                },
                                stream: (sql: any, values: any) => {
                                    throw new Error('pg-mem does not support streaming');
                                },
                            }
                        },
                    }
                })
            })
        } else {
            // old slonik versions
            return slonik.createMockPool({
                query: async (sql: string, args: any[]) => {
                    await delay(opts?.queryLatency ?? 0);
                    const formatted = replaceQueryArgs$(sql, args);
                    const ret = this.db.public.many(formatted);
                    return slonik.createMockQueryResult(ret);
                },
            }, opts?.clientConfigurationInput);
        }
    }


    createPgPromise(queryLatency?: number) {
        // https://vitaly-t.github.io/pg-promise/module-pg-promise.html
        // https://github.com/vitaly-t/pg-promise/issues/743#issuecomment-756110347
        const pgp = doRequire('pg-promise')();
        pgp.pg = this.createPg(queryLatency);
        const db = pgp('pg-mem');
        if (compareVersions('10.8.7', db.$config.version) < 0) {
            throw new Error(`💀 pg-mem cannot be used with pg-promise@${db.$config.version},

       👉 you must install version pg-promise@10.8.7 or newer:

                npm i pg-promise@latest -S

            See https://github.com/vitaly-t/pg-promise/issues/743 for details`);
        }
        return db;
    }

    createPgNative(queryLatency?: number) {
        queryLatency = queryLatency ?? 0;
        const prepared = new lru<string, string>({
            max: 1000,
            maxAge: 5000,
        });
        function handlerFor(a: any, b: any) {
            return typeof a === 'function' ? a : b;
        }
        const that = this;
        return class Client {
            async connect(a: any, b: any) {
                const handler = handlerFor(a, b);
                await delay(queryLatency);
                handler?.();
            }

            connectSync() {
                // nop
            }

            async prepare(name: string, sql: string, npar: number, callback: any) {
                await delay(queryLatency);
                this.prepareSync(name, sql, npar);
                callback();
            }

            prepareSync(name: string, sql: string, npar: number) {
                prepared.set(name, sql);
            }

            async execute(name: string, a: any, b: any) {
                const handler = handlerFor(a, b);
                const pars = Array.isArray(a) ? a : [];
                await delay(queryLatency);
                try {
                    const rows = this.executeSync(name, pars);
                    handler(null, rows);
                } catch (e) {
                    handler(e);
                }
            }
            executeSync(name: string, pars?: any) {
                pars = Array.isArray(pars) ? pars : [];
                const prep = prepared.get(name);
                if (!prep) {
                    throw new Error('Unkown prepared statement ' + name);
                }
                return this.querySync(prep, pars);
            }


            async query(sql: string, b: any, c: any) {
                const handler = handlerFor(b, c);
                const params = Array.isArray(b) ? b : [];
                try {
                    await delay(queryLatency);
                    const result = this.querySync(sql, params);
                    handler(null, result);
                } catch (e) {
                    handler?.(e);
                }
            }

            querySync(sql: string, params: any[]) {
                sql = replaceQueryArgs$(sql, params);
                const ret = that.db.public.many(sql);
                return ret;
            }
        }
    }

    createKnex(queryLatency?: number, knexConfig?: object): any {
        const knex = doRequire('knex')({
            connection: {},
            ...knexConfig,
            client: 'pg',
        });
        knex.client.driver = this.createPg(queryLatency);
        knex.client.version = 'pg-mem';
        return knex;
    }

    createKysely(queryLatency?: number, kyselyConfig?: object): any {
        const { Kysely, PostgresDialect } = doRequire('kysely');
        const pg = this.createPg(queryLatency);
        return new Kysely({
            ...kyselyConfig,
            dialect: new PostgresDialect({
                pool: new pg.Pool(),
            }),
        });
    }

    async createMikroOrm(mikroOrmOptions: any, queryLatency?: number) {

        const { MikroORM } = doRequire('@mikro-orm/core');
        const { AbstractSqlDriver, PostgreSqlConnection, PostgreSqlPlatform } = doRequire('@mikro-orm/postgresql');
        const that = this;

        // see https://github.com/mikro-orm/mikro-orm/blob/aa71065d0727920db7da9bfdecdb33e6b8165cb5/packages/postgresql/src/PostgreSqlConnection.ts#L5
        class PgMemConnection extends PostgreSqlConnection {
            protected createKnexClient(type: string) {
                return that.createKnex();
            }

            async execute(query: string, params: any[] = [], method: 'all' | 'get' | 'run' = 'all'): Promise<any> {
                // pg-mem does not support `set names 'utf8';` yet
                // the hack in line 355 works only for a single query while this one works beforehand to strip it from multiline queries
                return super.execute(query.replace('set names \'utf8\';', ''), params, method);
            }

        }
        // see https://github.com/mikro-orm/mikro-orm/blob/master/packages/postgresql/src/PostgreSqlDriver.ts
        class PgMemDriver extends AbstractSqlDriver<PgMemConnection> {
            constructor(config: any) {
                super(config, new PostgreSqlPlatform(), PgMemConnection, ['knex', 'pg']);
            }
        }

        const orm = await MikroORM.init({
            ...mikroOrmOptions,
            dbName: 'public',
            driver: PgMemDriver,
        });
        return orm;
    }

    createPostgresJsTag(queryLatency?: number): any {
        const pg = doRequire('postgres').default;
        const sql = pg({
            socket: () => {
                return socketAdapter()(this.db.public, queryLatency);
            },
        });
        return sql;
    }


    async bindServer(opts?: BindServerOptions): Promise<BindServerResult> {
        const { createServer } = doRequire('net') as typeof import('net');
        const srv = createServer();
        return new Promise<BindServerResult>((res, rej) => {
            srv.listen(opts?.port ?? 0, opts?.host ?? '127.0.0.1', () => {
                const a = srv.address();
                if (!a) {
                    srv.close();
                    return rej('cannot find a port');
                }
                if (typeof a === 'string') {
                    srv.close();
                    return rej('cannot find a port');
                }

                srv.on('connection', (socket) => {
                    bindPgServer(socket, this.db.public);
                });

                res({
                    postgresConnectionString: `postgresql://${a.address}:${a.port}/postgres?sslmode=disable`,
                    connectionSettings: {
                        port: a.port,
                        host: a.address,
                    },
                    close: () => {
                        srv.close();
                    },
                })
            });
        });
    }
}
