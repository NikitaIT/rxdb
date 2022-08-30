import { Observable, Subject } from 'rxjs';
import { getPrimaryFieldOfPrimaryKey } from '../../rx-schema-helper';
import type {
    BulkWriteRow,
    EventBulk,
    RxConflictResultionTask,
    RxConflictResultionTaskSolution,
    RxDocumentData,
    RxDocumentDataById,
    RxJsonSchema,
    RxStorageBulkWriteResponse,
    RxStorageChangeEvent,
    RxStorageDefaultCheckpoint,
    RxStorageInstance,
    RxStorageInstanceCreationParams,
    RxStorageQueryResult,
    StringKeys
} from '../../types';
import type {
    FoundationDBConnection,
    FoundationDBDatabase,
    FoundationDBIndexMeta,
    FoundationDBStorageInternals,
    RxStorageFoundationDB,
    RxStorageFoundationDBInstanceCreationOptions,
    RxStorageFoundationDBSettings
} from './foundationdb-types';
import {
    open as foundationDBOpen,
    directory as foundationDBDirectory,
    encoders as foundationDBEncoders,
    keySelector as foundationDBKeySelector,
    StreamingMode as foundationDBStreamingMode
} from 'foundationdb';
import { categorizeBulkWriteRows, getNewestOfDocumentStates } from '../../rx-storage-helper';
import { CLEANUP_INDEX, getDocumentsByKey, getFoundationDBIndexName } from './foundationdb-helpers';
import { newRxError } from '../../rx-error';
import { getIndexableStringMonad, getStartIndexStringFromLowerBound, getStartIndexStringFromUpperBound } from '../../custom-index';
import {
    ensureNotFalsy, lastOfArray, now
    , PROMISE_RESOLVE_VOID
} from '../../util';
import { queryFoundationDB } from './foundationdb-query';
import { INDEX_MAX } from '../../query-planner';

export class RxStorageInstanceFoundationDB<RxDocType> implements RxStorageInstance<
    RxDocType,
    FoundationDBStorageInternals<RxDocType>,
    RxStorageFoundationDBInstanceCreationOptions,
    RxStorageDefaultCheckpoint
> {
    public readonly primaryPath: StringKeys<RxDocumentData<RxDocType>>;

    public closed = false;
    private changes$: Subject<EventBulk<RxStorageChangeEvent<RxDocumentData<RxDocType>>, RxStorageDefaultCheckpoint>> = new Subject();

    constructor(
        public readonly storage: RxStorageFoundationDB,
        public readonly databaseName: string,
        public readonly collectionName: string,
        public readonly schema: Readonly<RxJsonSchema<RxDocumentData<RxDocType>>>,
        public readonly internals: FoundationDBStorageInternals<RxDocType>,
        public readonly options: Readonly<RxStorageFoundationDBInstanceCreationOptions>,
        public readonly settings: RxStorageFoundationDBSettings
    ) {
        this.primaryPath = getPrimaryFieldOfPrimaryKey(this.schema.primaryKey);
    }

    async bulkWrite(
        documentWrites: BulkWriteRow<RxDocType>[],
        context: string
    ): Promise<RxStorageBulkWriteResponse<RxDocType>> {
        const ret: RxStorageBulkWriteResponse<RxDocType> = {
            success: {},
            error: {}
        };
        const dbs = await this.internals.dbsPromise;
        await dbs.root.doTransaction(async tx => {
            const ids = documentWrites.map(row => (row.document as any)[this.primaryPath]);

            const mainTx = tx.at(dbs.main.subspace);

            const docsInDB = new Map<string, RxDocumentData<RxDocType>>();
            /**
             * TODO this might be faster if fdb
             * any time adds a bulk-fetch-by-key method.
             */
            await Promise.all(
                ids.map(async (id) => {
                    const doc = await mainTx.get(id);
                    docsInDB.set(id, doc);
                })
            );


            const categorized = categorizeBulkWriteRows<RxDocType>(
                this,
                this.primaryPath as any,
                docsInDB,
                documentWrites,
                context
            );

            categorized.errors.forEach(err => {
                ret.error[err.documentId] = err;
            });

            // INSERTS
            categorized.bulkInsertDocs.forEach(writeRow => {
                const docId: string = writeRow.document[this.primaryPath] as any;
                ret.success[docId as any] = writeRow.document;

                // insert document data
                mainTx.set(docId, writeRow.document);

                // insert secondary indexes
                Object.values(dbs.indexes).forEach(indexMeta => {
                    const indexString = indexMeta.getIndexableString(writeRow.document);
                    const indexTx = tx.at(indexMeta.db.subspace);
                    indexTx.set(indexString, docId);
                });
            });
            // UPDATES
            categorized.bulkUpdateDocs.forEach((writeRow: BulkWriteRow<RxDocType>) => {
                const docId: string = writeRow.document[this.primaryPath] as any;

                // overwrite document data
                mainTx.set(docId, writeRow.document);

                // update secondary indexes
                console.dir(writeRow.previous);
                console.dir(writeRow.document);
                Object.values(dbs.indexes).forEach(indexMeta => {
                    const oldIndexString = indexMeta.getIndexableString(ensureNotFalsy(writeRow.previous));
                    const newIndexString = indexMeta.getIndexableString(writeRow.document);

                    console.log('# bulkWriteUPDATE ' + indexMeta.indexName);
                    console.log('oldIndexString: ' + oldIndexString);
                    console.log('newIndexString: ' + newIndexString);

                    if (oldIndexString !== newIndexString) {
                        const indexTx = tx.at(indexMeta.db.subspace);
                        indexTx.delete(oldIndexString);
                        indexTx.set(newIndexString, docId);
                    }
                });
                ret.success[docId as any] = writeRow.document;
            });

            if (categorized.eventBulk.events.length > 0) {
                const lastState = getNewestOfDocumentStates(
                    this.primaryPath as any,
                    Object.values(ret.success)
                );
                categorized.eventBulk.checkpoint = {
                    id: lastState[this.primaryPath],
                    lwt: lastState._meta.lwt
                };
                this.changes$.next(categorized.eventBulk);
            }
        });

        return ret;
    }

    async findDocumentsById(ids: string[], withDeleted: boolean): Promise<RxDocumentDataById<RxDocType>> {
        const dbs = await this.internals.dbsPromise;
        const ret: RxDocumentDataById<RxDocType> = {};
        await dbs.main.doTransaction(async tx => {
            await Promise.all(
                ids.map(async (docId) => {
                    const docInDb = await tx.get(docId);
                    if (
                        docInDb &&
                        (
                            !docInDb._deleted ||
                            withDeleted
                        )
                    ) {
                        ret[docId] = docInDb;
                    }
                })
            );
        });
        return ret;
    }
    query(preparedQuery: any): Promise<RxStorageQueryResult<RxDocType>> {
        console.dir(preparedQuery);
        return queryFoundationDB(this, preparedQuery);
        throw new Error('Method not implemented.');

    }
    getAttachmentData(documentId: string, attachmentId: string): Promise<string> {
        throw new Error('Method not implemented.');
    }
    async getChangedDocumentsSince(limit: number, checkpoint?: RxStorageDefaultCheckpoint): Promise<{ documents: RxDocumentData<RxDocType>[]; checkpoint: RxStorageDefaultCheckpoint; }> {
        const dbs = await this.internals.dbsPromise;
        const index = [
            '_meta.lwt',
            this.primaryPath as any
        ];
        const indexName = getFoundationDBIndexName(index);
        const indexMeta = dbs.indexes[indexName];
        let lowerBoundString = '';
        if (checkpoint) {
            const checkpointPartialDoc: any = {
                [this.primaryPath]: checkpoint.id,
                _meta: {
                    lwt: checkpoint.lwt
                }
            };
            lowerBoundString = indexMeta.getIndexableString(checkpointPartialDoc);
        }
        let result: RxDocumentData<RxDocType>[] = [];
        await dbs.root.doTransaction(async tx => {
            const indexTx = tx.at(indexMeta.db.subspace);
            const mainTx = tx.at(dbs.main.subspace);
            const range = await indexTx.getRangeAll(
                foundationDBKeySelector.firstGreaterThan(lowerBoundString),
                INDEX_MAX,
                {
                    limit,
                    streamingMode: foundationDBStreamingMode.Exact
                }
            );
            const docIds = range.map(row => row[1]);
            const docsData: RxDocumentData<RxDocType>[] = await Promise.all(docIds.map(docId => mainTx.get(docId)));
            result = result.concat(docsData);
        });
        const lastDoc = lastOfArray(result);
        return {
            documents: result,
            checkpoint: lastDoc ? {
                id: lastDoc[this.primaryPath] as any,
                lwt: lastDoc._meta.lwt
            } : checkpoint ? checkpoint : {
                id: '',
                lwt: 0
            }
        };
    }
    changeStream(): Observable<EventBulk<RxStorageChangeEvent<RxDocType>, RxStorageDefaultCheckpoint>> {
        return this.changes$.asObservable();
    }

    async remove(): Promise<void> {
        const dbs = await this.internals.dbsPromise;
        await dbs.root.doTransaction(tx => {
            tx.clearRange('', INDEX_MAX);
            return PROMISE_RESOLVE_VOID;
        });
        return this.close();
    }
    async cleanup(minimumDeletedTime: number): Promise<boolean> {
        const maxDeletionTime = now() - minimumDeletedTime;
        const dbs = await this.internals.dbsPromise;
        const index = CLEANUP_INDEX;
        const indexName = getFoundationDBIndexName(index);
        const indexMeta = dbs.indexes[indexName];
        const lowerBoundString = getStartIndexStringFromLowerBound(
            this.schema,
            index,
            [
                true,
                /**
                 * Do not use 0 here,
                 * because 1 is the minimum value for _meta.lwt
                 */
                1
            ]
        );
        const upperBoundString = getStartIndexStringFromUpperBound(
            this.schema,
            index,
            [
                true,
                maxDeletionTime
            ]
        );
        let noMoreUndeleted: boolean = true;
        await dbs.root.doTransaction(async tx => {
            const batchSize = ensureNotFalsy(this.settings.batchSize);
            const indexTx = tx.at(indexMeta.db.subspace);
            const mainTx = tx.at(dbs.main.subspace);
            const range = await indexTx.getRangeAll(
                foundationDBKeySelector.firstGreaterThan(lowerBoundString),
                upperBoundString,
                {
                    limit: batchSize + 1, // get one more extra to detect what to return from cleanup()
                    streamingMode: foundationDBStreamingMode.Exact
                }
            );
            if (range.length > batchSize) {
                noMoreUndeleted = false;
                range.pop();
            }
            const docIds = range.map(row => row[1]);
            const docsData: RxDocumentData<RxDocType>[] = await Promise.all(docIds.map(docId => mainTx.get(docId)));

            Object
                .values(dbs.indexes)
                .forEach(indexMeta => {
                    const subIndexDB = tx.at(indexMeta.db.subspace);
                    docsData.forEach(docData => {
                        const indexString = indexMeta.getIndexableString(docData);
                        subIndexDB.delete(indexString);
                    });
                });
            docIds.forEach(id => mainTx.delete(id));
        });

        return noMoreUndeleted;
    }

    conflictResultionTasks(): Observable<RxConflictResultionTask<RxDocType>> {
        return new Subject<any>().asObservable();
    }
    resolveConflictResultionTask(_taskSolution: RxConflictResultionTaskSolution<RxDocType>): Promise<void> {
        return PROMISE_RESOLVE_VOID;
    }

    async close() {
        if (this.closed) {
            return Promise.reject(newRxError('SNH', {
                database: this.databaseName,
                collection: this.collectionName
            }));
        }
        this.closed = true;
        this.changes$.complete();

        const dbs = await this.internals.dbsPromise;
        dbs.main.close();

        // TODO shouldnt we close the index databases?
        // Object.values(dbs.indexes).forEach(db => db.close());
    }
}



const FDB_ROOT_BY_CLUSTER_FILE_PATH = new Map<string, FoundationDBConnection>();
export function getFoundationDBConnection(
    clusterFilePath: string = ''
): FoundationDBConnection {
    return foundationDBOpen(clusterFilePath ? clusterFilePath : undefined);
    let dbConnection = FDB_ROOT_BY_CLUSTER_FILE_PATH.get(clusterFilePath);
    if (!dbConnection) {
        dbConnection = foundationDBOpen(clusterFilePath ? clusterFilePath : undefined);
        FDB_ROOT_BY_CLUSTER_FILE_PATH.set(clusterFilePath, dbConnection);
    }
    return dbConnection;
}


export async function createFoundationDBStorageInstance<RxDocType>(
    storage: RxStorageFoundationDB,
    params: RxStorageInstanceCreationParams<RxDocType, RxStorageFoundationDBInstanceCreationOptions>,
    settings: RxStorageFoundationDBSettings
): Promise<RxStorageInstanceFoundationDB<RxDocType>> {
    const primaryPath = getPrimaryFieldOfPrimaryKey(params.schema.primaryKey);
    const connection = getFoundationDBConnection(settings.clusterFile);
    const dbName = [
        'rxdb',
        params.databaseName,
        params.collectionName,
        params.schema.version
    ].join('::');
    const dbsPromise = (async () => {
        const directory = await foundationDBDirectory.createOrOpen(connection, dbName);
        const root = connection.at(directory);
        const main: FoundationDBDatabase<RxDocType> = root
            .at('main.')
            .withKeyEncoding(foundationDBEncoders.tuple) // automatically encode & decode keys using tuples
            .withValueEncoding(foundationDBEncoders.json) as any; // and values using JSON

        const indexDBs: { [indexName: string]: FoundationDBIndexMeta<RxDocType> } = {};
        const useIndexes = params.schema.indexes ? params.schema.indexes.slice(0) : [];
        useIndexes.push([primaryPath]);
        const useIndexesFinal = useIndexes.map(index => {
            const indexAr = Array.isArray(index) ? index.slice(0) : [index];
            indexAr.unshift('_deleted');
            return indexAr;
        })
        // used for `getChangedDocumentsSince()`
        useIndexesFinal.push([
            '_meta.lwt',
            primaryPath
        ]);
        useIndexesFinal.push(CLEANUP_INDEX);
        useIndexesFinal.forEach(indexAr => {
            const indexName = getFoundationDBIndexName(indexAr);
            const indexDB = root.at(indexName + '.')
                .withKeyEncoding(foundationDBEncoders.string)
                .withValueEncoding(foundationDBEncoders.string);
            indexDBs[indexName] = {
                indexName,
                db: indexDB,
                getIndexableString: getIndexableStringMonad(params.schema, indexAr),
                index: indexAr
            };
        });

        return {
            root,
            main,
            indexes: indexDBs
        };
    })();


    const internals: FoundationDBStorageInternals<RxDocType> = {
        connection,
        dbsPromise: dbsPromise
    };

    const instance = new RxStorageInstanceFoundationDB(
        storage,
        params.databaseName,
        params.collectionName,
        params.schema,
        internals,
        params.options,
        settings
    );
    return Promise.resolve(instance);
}