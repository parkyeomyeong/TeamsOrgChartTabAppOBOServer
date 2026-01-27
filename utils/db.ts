import oracledb from 'oracledb';
import dotenv from 'dotenv';

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
        });
        console.log('Oracle DB 커넥션 풀이 성공적으로 생성되었습니다.');
    } catch (err) {
        console.error('Oracle DB 커넥션 풀 생성 실패:', err);
        throw err;
    }
};

export const closeDB = async () => {
    try {
        if (pool) {
            await pool.close(10);
            console.log('Oracle DB 커넥션 풀이 닫혔습니다.');
        }
    } catch (err) {
        console.error('Oracle DB 커넥션 풀 종료 중 오류 발생:', err);
    }
};

export const execute = async (sql: string, binds: any[] = [], options: oracledb.ExecuteOptions = {}) => {
    if (!pool) {
        throw new Error('데이터베이스 풀이 초기화되지 않았습니다.');
    }

    let connection;

    try {
        connection = await pool.getConnection();

        const defaultOptions: oracledb.ExecuteOptions = {
            outFormat: oracledb.OUT_FORMAT_OBJECT, // 결과 컬럼명을 키로 하는 객체 반환
            autoCommit: true,
            ...options
        };

        const result = await connection.execute(sql, binds, defaultOptions);
        return result;

    } catch (err) {
        console.error('데이터베이스 실행 오류:', err);
        throw err;
    } finally {
        if (connection) {
            try {
                await connection.close();
            } catch (closeErr) {
                console.error('커넥션 반납 중 오류:', closeErr);
            }
        }
    }
};
