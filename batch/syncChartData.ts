import cron from 'node-cron';
import * as msal from '@azure/msal-node';
import { execute, executeTransaction } from '../utils/db';
import logger from '../utils/logger';
import { refreshAllPhotos } from '../utils/photoCache';
import {
    COUNT_SOURCE_USERS, COUNT_SOURCE_GROUPS,
    DELETE_CHART_GROUPS, INSERT_CHART_GROUPS,
    DELETE_CHART_USERS, INSERT_CHART_USERS
} from '../queries/batchSync';

// 원본 테이블 → _CHART 테이블로 데이터 복사 (일일 배치)
// 원본 데이터에 문제가 생겨도 _CHART 테이블에는 마지막 정상 데이터가 유지됨
const syncChartTables = async () => {
    const batchId = `batch-${Date.now().toString(36)}`;
    logger.batch(`[${batchId}] ===== 일일 배치 시작: 원본 → _CHART 테이블 동기화 =====`);

    try {
        // 1. 원본 테이블 건수 확인 (0건이면 스킵 — 빈 데이터로 덮어쓰기 방지)
        const userCount = await execute(COUNT_SOURCE_USERS, [], {}, batchId);
        const groupCount = await execute(COUNT_SOURCE_GROUPS, [], {}, batchId);

        const userCnt = (userCount.rows as any[])[0]?.cnt || 0;
        const groupCnt = (groupCount.rows as any[])[0]?.cnt || 0;

        logger.batch(`[${batchId}] 원본 건수 확인 — USER: ${userCnt}건, GROUPS: ${groupCnt}건`);

        if (userCnt === 0 || groupCnt === 0) {
            logger.batch(`[${batchId}] 원본 테이블이 비어있어 배치를 스킵합니다. 기존 _CHART 데이터를 유지합니다.`);
            return;
        }

        // 2. 하나의 트랜잭션으로 DELETE → INSERT 실행
        //    중간에 실패하면 전체 롤백 → 기존 _CHART 데이터 보존
        await executeTransaction([
            DELETE_CHART_GROUPS,
            INSERT_CHART_GROUPS,
            DELETE_CHART_USERS,
            INSERT_CHART_USERS,
        ], batchId);

        logger.batch(`[${batchId}] ===== 일일 배치 완료: USER ${userCnt}건, GROUPS ${groupCnt}건 동기화 =====`);

    } catch (err) {
        logger.batchError(`[${batchId}] 일일 배치 실패: ${err}`);
    }
};

// 일일 스케줄러 등록 (HR 동기화 + 사진 갱신)
export const startBatchScheduler = (cca: msal.ConfidentialClientApplication) => {
    // 매일 01:00 — HR 데이터 동기화
    cron.schedule('0 1 * * *', () => syncChartTables());
    logger.batch('일일 배치 스케줄러 등록 완료 (매일 01:00 KST)');

    // 매일 01:30 — 프로필 사진 갱신 (HR 배치 후)
    cron.schedule('30 1 * * *', () => {
        refreshAllPhotos(cca).catch((err: any) => logger.warn(`[Photo Refresh] 실패: ${err}`));
    });
    logger.batch('사진 갱신 스케줄러 등록 완료 (매일 01:30 KST)');
};

// 수동 실행용 (테스트 또는 긴급 동기화)
export { syncChartTables };
