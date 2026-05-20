import fs from 'fs';
import path from 'path';
import { execute } from '../utils/db';
import { GET_USER_FAVORITES, INSERT_USER_FAVORITE, DELETE_USER_FAVORITE } from '../queries/favorites';
import logger from '../utils/logger';

const MOCK_DB_PATH = path.join(__dirname, '../data/mockFavorites.json');
const USE_MOCK_DB = process.env.USE_MOCK_DB === 'true';

// 즐겨찾기 목록 항목 (응답 DTO)
export interface FavoriteItem {
    targetEmpId: string;
    createdAt: string;
}

// Mock JSON 파일 내부 구조
interface MockFavoriteEntry {
    userEmpId: string;
    targetEmpId: string;
    createdAt: string;
}

// 헬퍼: JSON 모의 파일 DB 읽기
const readMockFile = (): MockFavoriteEntry[] => {
    try {
        if (!fs.existsSync(MOCK_DB_PATH)) {
            const dir = path.dirname(MOCK_DB_PATH);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(MOCK_DB_PATH, JSON.stringify([]));
            return [];
        }
        const raw = fs.readFileSync(MOCK_DB_PATH, 'utf-8');
        return JSON.parse(raw || '[]');
    } catch (err) {
        logger.error(`[MockDB] 파일 읽기 실패: ${err}`);
        return [];
    }
};

// 헬퍼: JSON 모의 파일 DB 쓰기
const writeMockFile = (data: MockFavoriteEntry[]): void => {
    try {
        const dir = path.dirname(MOCK_DB_PATH);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(MOCK_DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
    } catch (err) {
        logger.error(`[MockDB] 파일 쓰기 실패: ${err}`);
    }
};

export const favoritesRepository = {
    /**
     * 특정 사용자의 즐겨찾기 목록 조회
     * @param userEmpId - 로그인한 사용자의 사원 ID (사번)
     */
    getFavorites: async (userEmpId: string, requestId?: string): Promise<FavoriteItem[]> => {
        if (USE_MOCK_DB) {
            logger.info(`[${requestId}][Repository] Mock DB 사용 - 즐겨찾기 조회: userEmpId=${userEmpId}`);
            const data = readMockFile();
            return data
                .filter(item => item.userEmpId === userEmpId)
                .map(item => ({
                    targetEmpId: item.targetEmpId,
                    createdAt: item.createdAt
                }));
        } else {
            logger.info(`[${requestId}][Repository] Oracle DB 사용 - 즐겨찾기 조회: userEmpId=${userEmpId}`);
            const result = await execute(GET_USER_FAVORITES, { userEmpId } as any, {}, requestId);
            return result.rows as FavoriteItem[];
        }
    },

    /**
     * 즐겨찾기 대상 추가
     * @param userEmpId - 로그인한 사용자의 사원 ID (사번)
     * @param targetEmpId - 즐겨찾기 등록 대상 사원 ID (사번)
     */
    addFavorite: async (userEmpId: string, targetEmpId: string, requestId?: string): Promise<FavoriteItem> => {
        const getKSTStr = () => new Date().toLocaleString('ko-KR', {
            timeZone: 'Asia/Seoul', hour12: false,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        }).replace(/\. /g, '-').replace('.', '');

        const nowStr = getKSTStr();

        if (USE_MOCK_DB) {
            logger.info(`[${requestId}][Repository] Mock DB 사용 - 즐겨찾기 추가: ${userEmpId} -> ${targetEmpId}`);
            const data = readMockFile();

            const exists = data.some(item => item.userEmpId === userEmpId && item.targetEmpId === targetEmpId);
            if (exists) {
                const err = new Error('이미 즐겨찾기에 등록된 사원입니다.');
                (err as any).status = 409;
                throw err;
            }

            const newEntry: MockFavoriteEntry = { userEmpId, targetEmpId, createdAt: nowStr };
            data.push(newEntry);
            writeMockFile(data);

            return { targetEmpId, createdAt: nowStr };
        } else {
            logger.info(`[${requestId}][Repository] Oracle DB 사용 - 즐겨찾기 추가: ${userEmpId} -> ${targetEmpId}`);
            try {
                await execute(INSERT_USER_FAVORITE, { userEmpId, targetEmpId } as any, { autoCommit: true }, requestId);
                return { targetEmpId, createdAt: nowStr };
            } catch (err: any) {
                // Oracle 고유 제약 위반(ORA-00001) → 409 Conflict로 치환
                if (err.message && err.message.includes('ORA-00001')) {
                    const error = new Error('이미 즐겨찾기에 등록된 사원입니다.');
                    (error as any).status = 409;
                    throw error;
                }
                throw err;
            }
        }
    },

    /**
     * 즐겨찾기 대상 삭제
     * @param userEmpId - 로그인한 사용자의 사원 ID (사번)
     * @param targetEmpId - 즐겨찾기 해제 대상 사원 ID (사번)
     */
    removeFavorite: async (userEmpId: string, targetEmpId: string, requestId?: string): Promise<void> => {
        if (USE_MOCK_DB) {
            logger.info(`[${requestId}][Repository] Mock DB 사용 - 즐겨찾기 삭제: ${userEmpId} -> ${targetEmpId}`);
            const data = readMockFile();

            const filtered = data.filter(item => !(item.userEmpId === userEmpId && item.targetEmpId === targetEmpId));

            if (data.length === filtered.length) {
                const err = new Error('즐겨찾기 목록에 존재하지 않는 사원입니다.');
                (err as any).status = 404;
                throw err;
            }

            writeMockFile(filtered);
        } else {
            logger.info(`[${requestId}][Repository] Oracle DB 사용 - 즐겨찾기 삭제: ${userEmpId} -> ${targetEmpId}`);
            const result = await execute(DELETE_USER_FAVORITE, { userEmpId, targetEmpId } as any, { autoCommit: true }, requestId);

            if (result.rowsAffected === 0) {
                const err = new Error('즐겨찾기 목록에 존재하지 않는 사원입니다.');
                (err as any).status = 404;
                throw err;
            }
        }
    }
};
