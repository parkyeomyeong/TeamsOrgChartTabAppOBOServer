import oracledb from 'oracledb';
import dotenv from 'dotenv';
import logger from './logger';

dotenv.config();

// Oracle Instant Client를 별도로 설치하지 않아도 되는 Thin Mode 활성화
// oracledb.initOracleClient({ libDir: 'C:\\oracle\\instantclient_...' }); // Thick mode가 필요할 경우 경로 지정

let pool: oracledb.Pool | null = null;
let reconnectPromise: Promise<void> | null = null; // 동시 재연결 요청 시 Promise 공유용

// 풀 설정을 변수로 분리 (initDB, reconnectPool 양쪽에서 동일 설정 사용)
const poolConfig: oracledb.PoolAttributes = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectString: process.env.DB_CONNECT_STRING,
    poolMin: 2,
    poolMax: 10,
    poolIncrement: 1,
    connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT) || 60, // DB 연결 시도 제한 시간 (초). .env의 DB_CONNECT_TIMEOUT으로 조정 가능
    poolPingInterval: 60,   // [추가] 60초 이상 유휴 상태인 커넥션은 getConnection() 시 자동으로 ping 후 죽었으면 폐기
    enableStatistics: true  // 통계 기능 활성화 (이게 없으면 getStatistics()가 null 반환 가능)
};

// 커넥션/네트워크 관련 에러인지 판별 (쿼리 문법 에러 등과 구분하기 위함)
const isConnectionError = (err: any): boolean => {
    const msg = String(err?.message || err || '');
    const connectionErrors = [
        'NJS-500', 'NJS-521',           // node-oracledb 내부 커넥션 에러
        'NJS-040', 'NJS-018',           // 풀에서 커넥션 획득 불가
        'ORA-03114', 'ORA-03135',       // 서버와의 연결 끊김
        'ORA-12541', 'ORA-12543',       // 리스너/네트워크 접속 불가
        'ORA-12170', 'ORA-12571',       // 연결 타임아웃
        'DPI-1080',                     // dead connection detected
    ];
    return connectionErrors.some(code => msg.includes(code));
};

export const initDB = async () => {
    try {
        pool = await oracledb.createPool(poolConfig);

        // [연결 테스트] createPool()은 풀 '객체'만 만들 뿐, 실제 DB 연결을 보장하지 않음 (Thin 모드 = Lazy Connection)
        // getConnection()을 호출해야 실제 TCP 연결이 발생하므로, 여기서 실패하면 DB가 안 붙는 것
        const testConn = await pool.getConnection();
        await testConn.close();

        logger.info('Oracle DB 커넥션 풀 생성 및 연결 테스트 성공.');
    } catch (err) {
        logger.error(`Oracle DB 연결 실패: ${err}`);
        throw err;
    }
};

/**
 * [추가] 풀 재생성 (네트워크 단절 → 복구 후 자동 재연결)
 * 
 * 동시에 여러 요청에서 커넥션 에러가 터지면 reconnectPool()이 동시에 호출될 수 있는데,
 * 풀을 여러 번 닫고 여는 건 낭비이므로 첫 번째 호출의 Promise를 공유하여 나머지는 대기합니다.
 */
const reconnectPool = async (): Promise<void> => {
    if (reconnectPromise) {
        logger.warn('[DB] 이미 재연결 진행 중... 완료를 대기합니다.');
        return reconnectPromise;
    }

    reconnectPromise = (async () => {
        try {
            // 기존 풀 정리 (이미 죽은 풀이라 close()도 실패할 수 있으므로 무시)
            if (pool) {
                try { await pool.close(0); } catch (e) {
                    logger.warn(`[DB] 기존 풀 종료 중 오류 (무시): ${e}`);
                }
                pool = null;
            }

            // 새 풀 생성 + 연결 테스트
            pool = await oracledb.createPool(poolConfig);
            const testConn = await pool.getConnection();
            await testConn.close();

            logger.info('[DB] 커넥션 풀 재생성 및 연결 테스트 성공.');
        } catch (err) {
            logger.error(`[DB] 커넥션 풀 재생성 실패: ${err}`);
            pool = null;
            throw err;
        } finally {
            reconnectPromise = null;
        }
    })();

    return reconnectPromise;
};

export const closeDB = async () => {
    try {
        if (pool) {
            await pool.close(10);
            logger.info('Oracle DB 커넥션 풀이 닫혔습니다.');
        }
    } catch (err) {
        logger.error(`Oracle DB 커넥션 풀 종료 중 오류 발생: ${err}`);
    }
};

/**
 * [추가] DB 연결 상태 확인 (Health Check 전용)
 * - 풀에서 커넥션을 가져와 ping 후 반납
 * - 실패해도 에러를 throw하지 않고 false 반환 (health check가 죽으면 안 되니까)
 */
export const pingDB = async (): Promise<boolean> => {
    try {
        if (!pool) return false;
        const conn = await pool.getConnection();
        await conn.ping();
        await conn.close();
        return true;
    } catch {
        return false;
    }
};

// [수정] requestId를 선택적으로 받아 에러 발생 시 어떤 요청에서 터졌는지 추적 가능하게 함
export const execute = async (sql: string, binds: any[] = [], options: oracledb.ExecuteOptions = {}, requestId?: string) => {
    // 풀이 없으면(이전에 재생성 실패 등) 재연결 시도
    if (!pool) {
        logger.warn(`[${requestId}][DB] 풀이 없습니다. 재연결을 시도합니다...`);
        await reconnectPool();
    }

    const defaultOptions: oracledb.ExecuteOptions = {
        outFormat: oracledb.OUT_FORMAT_OBJECT, // 결과 컬럼명을 키로 하는 객체 반환
        autoCommit: true,
        ...options
    };

    // 쿼리 실행 로직을 함수로 분리 (재시도 시 동일 로직 재사용)
    const runQuery = async (): Promise<oracledb.Result<unknown>> => {
        let connection;
        try {
            // connectionsOpen : 사용가능한 커넥션 수(연결해 놓은 커넥션 수)
            // connectionsInUse : 사용중인 커넥션 수(현재 사용중인 커넥션 수)
            logger.info(`[${requestId}][DB] 커넥션 요청 중... (Pool Status: Open=${pool!.getStatistics()?.connectionsOpen}, Busy=${pool!.getStatistics()?.connectionsInUse})`);
            connection = await pool!.getConnection();
            logger.info(`[${requestId}][DB] 커넥션 획득 성공. (Pool Status: Open=${pool!.getStatistics()?.connectionsOpen}, Busy=${pool!.getStatistics()?.connectionsInUse})`);

            const result = await connection.execute(sql, binds, defaultOptions);
            return result;
        } finally {
            if (connection) {
                try {
                    await connection.close();
                    logger.info(`[${requestId}][DB] 커넥션 반납 완료. (Pool Status: Open=${pool?.getStatistics()?.connectionsOpen}, Busy=${pool?.getStatistics()?.connectionsInUse})`);
                } catch (closeErr) {
                    logger.error(`[${requestId}][DB] 커넥션 반납 중 오류: ${closeErr}`);
                }
            }
        }
    };

    try {
        return await runQuery();
    } catch (err) {
        // 커넥션/네트워크 에러 → 풀 재생성 후 1회 재시도
        if (isConnectionError(err)) {
            logger.warn(`[${requestId}][DB] 커넥션 에러 감지 — 풀 재생성 후 재시도합니다: ${err}`);
            await reconnectPool();
            const result = await runQuery();
            logger.info(`[${requestId}][DB] 재시도 성공.`);
            return result;
        }

        // 쿼리 에러 (문법, 제약조건 등) → 그대로 throw
        logger.error(`[${requestId}][DB] 데이터베이스 실행 오류: ${err}`);
        throw err;
    }
};

// 트랜잭션 실행: 하나의 커넥션에서 여러 SQL을 순차 실행하고, 실패 시 전체 롤백
export const executeTransaction = async (queries: string[], requestId?: string) => {
    // 풀이 없으면 재연결 시도
    if (!pool) {
        logger.warn(`[${requestId}][DB] 풀이 없습니다. 재연결을 시도합니다...`);
        await reconnectPool();
    }

    // 트랜잭션 실행 로직을 함수로 분리 (재시도 시 동일 로직 재사용)
    const runTransaction = async (): Promise<void> => {
        let connection;
        try {
            connection = await pool!.getConnection();
            logger.info(`[${requestId}][DB] 트랜잭션 시작 (쿼리 ${queries.length}건)`);

            for (const sql of queries) {
                await connection.execute(sql, [], {
                    outFormat: oracledb.OUT_FORMAT_OBJECT,
                    autoCommit: false  // 개별 커밋 안 함
                });
            }

            await connection.commit();  // 전부 성공하면 한 번에 커밋
            logger.info(`[${requestId}][DB] 트랜잭션 커밋 완료`);
        } catch (err) {
            if (connection) {
                try { await connection.rollback(); } catch (_) {}
                logger.error(`[${requestId}][DB] 트랜잭션 롤백 완료`);
            }
            throw err;
        } finally {
            if (connection) {
                try { await connection.close(); } catch (closeErr) {
                    logger.error(`[${requestId}][DB] 커넥션 반납 중 오류: ${closeErr}`);
                }
            }
        }
    };

    try {
        await runTransaction();
    } catch (err) {
        // [추가] 커넥션/네트워크 에러 → 풀 재생성 후 트랜잭션 전체 1회 재시도
        if (isConnectionError(err)) {
            logger.warn(`[${requestId}][DB] 트랜잭션 중 커넥션 에러 감지 — 풀 재생성 후 재시도합니다: ${err}`);
            await reconnectPool();
            await runTransaction();
            logger.info(`[${requestId}][DB] 트랜잭션 재시도 성공.`);
            return;
        }

        logger.error(`[${requestId}][DB] 트랜잭션 실행 오류: ${err}`);
        throw err;
    }
};
