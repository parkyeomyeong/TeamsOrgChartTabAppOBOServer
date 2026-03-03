import axios from 'axios';
import * as msal from '@azure/msal-node';
import logger from './logger';
import { execute } from './db';
import {
    LOAD_ALL_UUID_MAP,
    UPSERT_UUID_MAP
} from '../queries/userIdCache';

// ================================================================
// Email → MS Graph UUID 인메모리 캐시
// ================================================================
// 목적: Presence 조회 시 매번 Graph API로 email→UUID 변환하는 것을 방지
// 구조: 인메모리 Map (서버 시작 시 Graph API로 전체 직원 UUID 프리로드)
//
// hitRate 계산식: hits / (hits + misses) × 100
//   예) hits=12, misses=3 → 12/(12+3)×100 = 80%
// ================================================================

// 인메모리 캐시 (email → uuid)
const cache = new Map<string, string>();

// 요청별 통계 (매 Presence 요청마다 리셋)
let requestHits = 0;
let requestMisses = 0;

// ── 핵심 함수: 이메일 → UUID 일괄 변환 ─────────────────────────

/**
 * 이메일 목록을 받아서 UUID로 변환하여 반환
 * 1. 캐시에 있으면 캐시에서 가져옴 (히트)
 * 2. 캐시에 없으면 Graph API로 조회 후 캐시에 저장 (미스)
 * 3. 모든 결과를 통합하여 {email, uuid} 배열 + uuidToEmailMap 반환
 *
 * @param emails 변환할 이메일 배열
 * @param accessToken Graph API 호출용 Bearer 토큰
 * @param requestId 로그 추적용 요청 ID
 * @returns resolved: {email, uuid} 배열, uuidToEmailMap: UUID→Email 역매핑
 */
export const resolveEmailsToUuids = async (
    emails: string[],
    accessToken: string,
    requestId?: string
): Promise<{
    resolved: { email: string; uuid: string }[];
    uuidToEmailMap: Map<string, string>;
}> => {
    const resolved: { email: string; uuid: string }[] = [];
    const uncached: string[] = [];

    // 1. 캐시 조회
    for (const email of emails) {
        const uuid = cache.get(email.toLowerCase());
        if (uuid) {
            resolved.push({ email, uuid });
            requestHits++;
        } else {
            uncached.push(email);
            requestMisses++;
        }
    }

    // 2. 캐시 미스 → 15건씩 배치로 Graph API 조회 + 캐시/DB 저장
    if (uncached.length > 0) {
        const LOOKUP_BATCH = 15; // URL 길이 제한 (~750자 이내 유지)
        logger.info(`[${requestId}] Graph API User Lookup (cache miss: ${uncached.length}건, ${Math.ceil(uncached.length / LOOKUP_BATCH)}배치)...`);

        for (let i = 0; i < uncached.length; i += LOOKUP_BATCH) {
            const batch = uncached.slice(i, i + LOOKUP_BATCH);
            const filterClause = batch.map(e => `userPrincipalName eq '${e}'`).join(' or ');

            try {
                const response = await axios.get(
                    `https://graph.microsoft.com/v1.0/users?$filter=${filterClause}&$select=id,userPrincipalName`,
                    {
                        headers: { Authorization: `Bearer ${accessToken}` },
                        timeout: 5000
                    }
                );

                for (const u of response.data.value) {
                    const email = u.userPrincipalName;
                    const uuid = u.id;

                    // 인메모리 캐시에 저장
                    cache.set(email.toLowerCase(), uuid);
                    resolved.push({ email, uuid });

                    // DB에 저장 (다음 서버 재시작 시 캐시 프리로드용)
                    try {
                        await execute(
                            UPSERT_UUID_MAP,
                            { email: email.toLowerCase(), uuid } as any,
                            { autoCommit: true }
                        );
                    } catch (dbErr) {
                        logger.warn(`[${requestId}] UUID DB 저장 실패 (${email}): ${dbErr}`);
                    }
                }

                logger.info(`[${requestId}] User Lookup 배치 ${i / LOOKUP_BATCH + 1} 완료 (${response.data.value.length}건 캐시+DB 저장)`);
            } catch (err) {
                logger.error(`[${requestId}] User Lookup 배치 ${i / LOOKUP_BATCH + 1} 실패: ${err}`);
            }
        }
    }

    // 3. UUID → Email 역매핑 생성 (Presence 응답에서 email로 변환용)
    const uuidToEmailMap = new Map<string, string>();
    for (const { email, uuid } of resolved) {
        uuidToEmailMap.set(uuid, email);
    }

    // 캐시 통계 로그 출력
    logCacheStats(requestId);

    return { resolved, uuidToEmailMap };
};

// ── 캐시 저장 (프리로드용) ──────────────────────────────────────

/**
 * 여러 건을 일괄 저장 (서버 시작 시 프리로드에서 사용)
 */
export const bulkSaveToCache = (entries: { email: string; uuid: string }[]): void => {
    for (const { email, uuid } of entries) {
        cache.set(email.toLowerCase(), uuid);
    }
};

// ── 캐시 통계 ──────────────────────────────────────────────────

/**
 * 현재 요청의 캐시 통계를 로그에 출력하고 요청별 카운터를 리셋
 */
const logCacheStats = (requestId?: string): void => {
    const total = requestHits + requestMisses;
    const hitRate = total > 0 ? ((requestHits / total) * 100).toFixed(1) : 'N/A';

    logger.info(
        `[${requestId}][UUID Cache] Stats: { size: ${cache.size}, hits: ${requestHits}, misses: ${requestMisses}, hitRate: "${hitRate}%" }`
    );

    // 요청별 카운터 리셋
    requestHits = 0;
    requestMisses = 0;
};

/**
 * 캐시 크기 반환 (디버깅용)
 */
export const getCacheSize = (): number => cache.size;


// ── 서버 시작 시 전체 직원 UUID 프리로드 ──────────────────────
// 흐름:
// 1. DB에 이미 저장된 매핑 로드 → 캐시 적재
// 2. HR 테이블에서 전체 직원 이메일 가져오기
// 3. DB에 없는 이메일만 Graph API로 UUID 조회
// 4. 새로 조회한 결과를 DB + 캐시에 저장

/**
 * @param cca MSAL ConfidentialClientApplication (server.ts에서 전달)
 */
export const preloadUserUuids = async (cca: msal.ConfidentialClientApplication): Promise<void> => {
    try {
        // 1. DB에서 기존 매핑 로드 → 인메모리 캐시에 적재
        const existingMap = await execute(LOAD_ALL_UUID_MAP, [], {});
        const existingRows = existingMap.rows as { email: string; uuid: string }[];
        bulkSaveToCache(existingRows);
        logger.info(`[UUID Preload] DB에서 기존 매핑 ${existingRows.length}건 로드 완료.`);

        // 기존 매핑의 이메일 목록 (Set으로 빠른 조회)
        const existingEmails = new Set(existingRows.map(r => r.email.toLowerCase()));

        // 3. HR 테이블에서 전체 직원 이메일 가져오기
        const empResult = await execute(
            `SELECT DISTINCT EMAIL AS "email" FROM HR_TO_TEAMS_USER_CHART WHERE EMAIL IS NOT NULL`,
            [], {}
        );
        const allEmails = (empResult.rows as { email: string }[]).map(r => r.email).filter(Boolean);
        logger.info(`[UUID Preload] HR 테이블에서 직원 이메일 ${allEmails.length}건 조회.`);

        // 4. DB에 없는 이메일만 필터링 (신규 입사자 등)
        const missingEmails = allEmails.filter(e => !existingEmails.has(e.toLowerCase()));
        logger.info(`[UUID Preload] 신규 매핑 필요: ${missingEmails.length}건 (기존 ${existingEmails.size}건은 DB에서 로드 완료)`);

        if (missingEmails.length === 0) {
            logger.info(`[UUID Preload] 완료: 추가 Graph API 호출 없음. 캐시 크기: ${getCacheSize()}`);
            return;
        }

        // 5. Client Credentials Flow로 앱 전용 토큰 획득
        //    ※ Azure AD에서 User.Read.All "애플리케이션 권한" + 관리자 동의 필요
        const tokenResponse = await cca.acquireTokenByClientCredential({
            scopes: ['https://graph.microsoft.com/.default']
        });

        if (!tokenResponse || !tokenResponse.accessToken) {
            logger.warn('[UUID Preload] Client Credentials 토큰 획득 실패. 신규 매핑 스킵.');
            return;
        }

        const appToken = tokenResponse.accessToken;

        // 6. 신규 이메일만 Graph API로 UUID 조회 (15명씩 배치)
        const LOOKUP_BATCH = 15;
        let loadedCount = 0;

        for (let i = 0; i < missingEmails.length; i += LOOKUP_BATCH) {
            const batch = missingEmails.slice(i, i + LOOKUP_BATCH);
            const filterClause = batch.map(email => `userPrincipalName eq '${email}'`).join(' or ');

            try {
                const res = await axios.get(
                    `https://graph.microsoft.com/v1.0/users?$filter=${filterClause}&$select=id,userPrincipalName`,
                    {
                        headers: { Authorization: `Bearer ${appToken}` },
                        timeout: 10000
                    }
                );

                // Graph API 결과를 캐시 + DB에 저장
                for (const u of res.data.value) {
                    const email = u.userPrincipalName;
                    const uuid = u.id;

                    // 인메모리 캐시에 저장
                    cache.set(email.toLowerCase(), uuid);

                    // DB에 저장 (MERGE — 있으면 UPDATE, 없으면 INSERT)
                    try {
                        await execute(
                            UPSERT_UUID_MAP,
                            { email: email.toLowerCase(), uuid } as any,
                            { autoCommit: true }
                        );
                    } catch (dbErr) {
                        logger.warn(`[UUID Preload] DB 저장 실패 (${email}): ${dbErr}`);
                    }

                    loadedCount++;
                }

            } catch (err: any) {
                // 429 응답 시 Retry-After 만큼 대기 후 재시도
                if (err.response?.status === 429) {
                    const retryAfter = parseInt(err.response.headers['retry-after'] || '10', 10);
                    logger.warn(`[UUID Preload] Rate limited. ${retryAfter}초 대기 후 재시도...`);
                    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                    i -= LOOKUP_BATCH; // 같은 배치를 다시 시도
                } else {
                    logger.warn(`[UUID Preload] 배치 ${i / LOOKUP_BATCH + 1} 실패 (건너뜀): ${err.message}`);
                }
            }
        }

        logger.info(`[UUID Preload] 완료: 신규 ${loadedCount}건 추가 (DB ${existingEmails.size}건 + 신규 ${loadedCount}건). 캐시 크기: ${getCacheSize()}`);

    } catch (err) {
        // 프리로드 실패는 치명적이지 않음 — 요청 시 개별 조회로 폴백
        logger.warn(`[UUID Preload] 프리로드 실패 (서비스는 정상 동작): ${err}`);
    }
};


