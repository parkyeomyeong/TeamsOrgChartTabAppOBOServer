import oracledb from 'oracledb';
import dotenv from 'dotenv';
import logger from './logger';

dotenv.config();

// Oracle Instant Client를 별도로 설치하지 않아도 되는 Thin Mode 활성화
// oracledb.initOracleClient({ libDir: 'C:\\oracle\\instantclient_...' }); // Thick mode가 필요할 경우 경로 지정

let pool: oracledb.Pool | null = null;

export const initDB = async () => {
    try {
        pool = await oracledb.createPool({
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            connectString: process.env.DB_CONNECT_STRING,
            poolMin: 2,
            poolMax: 10,
            poolIncrement: 1,
            connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT) || 60, // DB 연결 시도 제한 시간 (초). .env의 DB_CONNECT_TIMEOUT으로 조정 가능
            enableStatistics: true  // 통계 기능 활성화 (이게 없으면 getStatistics()가 null 반환 가능)
        });

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

// [수정] requestId를 선택적으로 받아 에러 발생 시 어떤 요청에서 터졌는지 추적 가능하게 함
export const execute = async (sql: string, binds: any[] = [], options: oracledb.ExecuteOptions = {}, requestId?: string) => {
    if (!pool) {
        throw new Error('데이터베이스 풀이 초기화되지 않았습니다.');
    }

    let connection;

    try {
        // connectionsOpen : 사용가능한 커넥션 수(연결해 놓은 커넥션 수)
        // connectionsInUse : 사용중인 커넥션 수(현재 사용중인 커넥션 수)
        logger.info(`[${requestId}][DB] 커넥션 요청 중... (Pool Status: Open=${pool.getStatistics()?.connectionsOpen}, Busy=${pool.getStatistics()?.connectionsInUse})`);
        connection = await pool.getConnection();
        logger.info(`[${requestId}][DB] 커넥션 획득 성공. (Pool Status: Open=${pool.getStatistics()?.connectionsOpen}, Busy=${pool.getStatistics()?.connectionsInUse})`);

        const defaultOptions: oracledb.ExecuteOptions = {
            outFormat: oracledb.OUT_FORMAT_OBJECT, // 결과 컬럼명을 키로 하는 객체 반환
            autoCommit: true,
            ...options
        };

        // logger.info(`[DB] 쿼리 실행 시작: ${sql.substring(0, 50)}...`);
        const result = await connection.execute(sql, binds, defaultOptions);
        // logger.info(`[DB] 쿼리 실행 완료.`);
        return result;

    } catch (err) {
        // [수정] 에러 로그에 Request ID 포함
        const idTag = requestId ? `[${requestId}] ` : '';
        logger.error(`[${idTag}][DB] 데이터베이스 실행 오류: ${err}`);
        throw err;
    } finally {
        if (connection) {
            try {
                await connection.close();
                logger.info(`[${requestId}][DB] 커넥션 반납 완료. (Pool Status: Open=${pool.getStatistics()?.connectionsOpen}, Busy=${pool.getStatistics()?.connectionsInUse})`);
            } catch (closeErr) {
                logger.error(`[${requestId}][DB] 커넥션 반납 중 오류: ${closeErr}`);
            }
        }
    }
};
