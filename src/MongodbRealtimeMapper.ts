
import { Observable, ReplaySubject, mergeMap, tap, throttleTime } from 'rxjs'
import {
    LogicalReplicationService,
    PgoutputPlugin
} from 'pg-logical-replication'
import pg from 'pg'


export type LogData<T = {}> = {
    tag: 'delete' | 'update' | 'insert' | 'begin' | 'relation' | 'commit'
    relation?: {
        tag: 'relation',
        relationOid: 16395,
        schema: 'public',
        name: string,
        replicaIdentity: 'full',
        keyColumns: string[]
    },
    old: T,
    new: T,

}


export type DatabaseEvent<T> = {
    table: string
    type: 'added' | 'modified' | 'removed',
    data: Partial<T>,
    old_data: T
}



const PUBLICATION = 'prp'
const SLOT_NAME = 'prs'


async function tryCatch<T>(fn: Promise<T> | (() => Promise<T>)) {
    try {
        const data = typeof fn == 'function' ? await fn() : await fn
        return [null, data] as [null, T]
    } catch (e) {
        return [e, null] as [Error, null]
    }
}

export const listenPostgresDataChange = (config: pg.ClientConfig) => new Observable<DatabaseEvent<{}>>(o => {

    const callback = new ReplaySubject<Function>()

    setTimeout(async () => {


        const client = new pg.Client(config)
        await client.connect()

        await tryCatch(client.query(`CREATE PUBLICATION ${PUBLICATION} FOR ALL TABLES`))
        await tryCatch(client.query(`SELECT pg_create_logical_replication_slot('${SLOT_NAME}','pgoutput')`))
 
        const service = new LogicalReplicationService(config, {
            acknowledge: {
                auto: true,
                timeoutSeconds: 10
            }
        })
        const plugin = new PgoutputPlugin({
            protoVersion: 1,
            publicationNames: [PUBLICATION]
        })


        setTimeout(async () => {
            while (true) {
                const [error] = await tryCatch(service.subscribe(plugin, SLOT_NAME))
                console.error(error)
                await new Promise(s => setTimeout(s, 100))
            }
        })

        const subscription = new Observable<{ lsn: string, log: LogData }>(o => {
            const fn = (lsn: string, log: LogData) => o.next({ log, lsn })
            service.on('data', fn)
            return () => service.removeListener('data', fn)
        }).pipe(
            tap(({ log }) => {
                const tag_mapping = {
                    'delete': 'removed',
                    'insert': 'added',
                    'update': 'modified'
                }
                const type = tag_mapping[log.tag]
                log.relation && type && o.next({
                    data: log.new,
                    old_data: log.old,
                    table: log.relation?.name,
                    type
                })
            }),
            throttleTime(1000),
            mergeMap(({ lsn }) => service.acknowledge(lsn))
        ).subscribe()




        callback.next(() => {
            subscription.unsubscribe()
            service.stop()
        })
    })

    return () => callback.subscribe(fn => fn())


})
