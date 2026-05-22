import fs from 'fs';
import path from 'path';
import { execute } from '../utils/db';
import { GET_USER_FAVORITES, INSERT_USER_FAVORITE, DELETE_USER_FAVORITE } from '../queries/favorites';
import logger from '../utils/logger';

// [로컬 가상환경 스위치] 환경변수에 USE_MOCK_DB=true 가 셋팅되었는지 검사합니다.
const USE_MOCK_DB = process.env.USE_MOCK_DB === 'true';

/**
 * [운영 배포 안정성용 동적 경로 계산기]
 * 1. 운영 서버(USE_MOCK_DB = false)에서는 디렉토리 생성이나 파일 권한 조회를 원천 차단합니다.
 *    (.gitignore로 인해 운영 배포 시 data/ 폴더가 유실되므로, 무조건 빈 문자열을 반환하여 에러를 방지함)
 * 2. 로컬 가상환경(USE_MOCK_DB = true)일 때만 디렉토리를 탐색하고 생성합니다.
 * 3. 만약 로컬 서버 권한이 막혀 폴더 생성에 실패하면 OS 임시 폴더(temp)로 우회(Fallback)하여 서버 크래시를 차단합니다.
 */
const getMockDbPath = (): string => {
    // 운영 환경이면 파일 처리를 전혀 하지 않으므로 즉시 빈 값으로 탈출
    if (!USE_MOCK_DB) return '';
    
    // 개발자가 환경변수로 특정 가상 DB 저장 경로를 직접 주입한 경우 해당 경로 우선 적용
    if (process.env.MOCK_FAVORITES_PATH) {
        return process.env.MOCK_FAVORITES_PATH;
    }
    
    // 기본 저장 폴더: 프로젝트 루트 아래의 data 폴더
    const defaultDir = path.join(__dirname, '../data');
    try {
        // data 폴더가 없을 경우에만 신규 생성
        if (!fs.existsSync(defaultDir)) {
            fs.mkdirSync(defaultDir, { recursive: true });
        }
    } catch (e) {
        // [안전 장치] OS의 파일 시스템 쓰기 권한 오류가 발생한 경우 OS의 임시 적재 공간(temp)을 사용하도록 자동 우회
        const os = require('os');
        return path.join(os.tmpdir(), 'mockFavorites.json');
    }
    
    // 안전하게 확보된 디렉토리 하위에 가상 파일 경로 반환
    return path.join(defaultDir, 'mockFavorites.json');
};

// 동적으로 계산된 안전 가상 DB 경로를 상수에 바인딩
const MOCK_DB_PATH = getMockDbPath();

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

/**
 * 헬퍼: JSON 모의 파일 DB 읽기
 * - 가상 모드(USE_MOCK_DB)가 꺼져 있거나 경로가 없으면 즉시 빈 배열을 반환하여 운영 런타임에 영향을 끼치지 않습니다.
 */
const readMockFile = (): MockFavoriteEntry[] => {
    // 안전 필터: 가상 환경 활성화 여부와 경로 확보 여부 사전 검증
    if (!USE_MOCK_DB || !MOCK_DB_PATH) return [];
    
    try {
        // 가상 DB 파일이 아직 존재하지 않는 경우 빈 배열([]) 파일 자동 생성
        if (!fs.existsSync(MOCK_DB_PATH)) {
            fs.writeFileSync(MOCK_DB_PATH, JSON.stringify([]));
            return [];
        }
        // 물리 파일에서 가상 데이터 문자열 읽기
        const raw = fs.readFileSync(MOCK_DB_PATH, 'utf-8');
        return JSON.parse(raw || '[]');
    } catch (err) {
        logger.error(`[MockDB] 파일 읽기 실패: ${err}`);
        return [];
    }
};

/**
 * 헬퍼: JSON 모의 파일 DB 쓰기
 * - 가상 모드가 꺼져 있거나 경로가 없으면 작업을 즉각 생략하여 운영 디스크 I/O 낭비 및 권한 충돌을 유발하지 않습니다.
 */
const writeMockFile = (data: MockFavoriteEntry[]): void => {
    // 안전 필터
    if (!USE_MOCK_DB || !MOCK_DB_PATH) return;
    
    try {
        // 가상 데이터를 파일 형태로 포맷하여 물리 디스크에 저장
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
