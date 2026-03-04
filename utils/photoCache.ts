import fs from 'fs';
import path from 'path';
import axios from 'axios';
import * as msal from '@azure/msal-node';
import logger from './logger';
import { getCacheSize, getUuidByEmail, getAllCachedUuids } from './userIdCache';

// ================================================================
// 프로필 사진 인메모리 + 파일시스템 캐시
// ================================================================
// L1: Map<uuid, base64> (런타임 서빙)
// L2: photos/{uuid}.jpg (서버 재시작 복구용)
// ================================================================

const PHOTOS_DIR = path.join(__dirname, '..', 'photos');
const cache = new Map<string, string>(); // uuid → base64

// ── 조회 ────────────────────────────────────────────────────────

/** 이메일 배열로 사진 조회 (email → uuid → photo) */
export const getPhotos = (emails: string[]): { email: string; photo: string | null }[] =>
    emails.map(email => {
        const uuid = getUuidByEmail(email);
        return { email, photo: uuid ? (cache.get(uuid) || null) : null };
    });

/** 캐시 메모리 사용량 (bytes) */
const getMemoryBytes = (): number => {
    let bytes = 0;
    for (const [k, v] of cache) bytes += k.length * 2 + v.length * 2;
    return bytes;
};

const formatMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);

// ── 프리로드 (서버 시작 시) ─────────────────────────────────────

export const preloadPhotos = async (cca: msal.ConfidentialClientApplication): Promise<void> => {
    try {
        // photos 폴더 생성
        if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

        // 1. 파일시스템에서 기존 사진 로드
        const files = fs.readdirSync(PHOTOS_DIR).filter(f => f.endsWith('.jpg'));
        for (const file of files) {
            const uuid = path.basename(file, '.jpg');
            const data = fs.readFileSync(path.join(PHOTOS_DIR, file));
            cache.set(uuid, `data:image/jpeg;base64,${data.toString('base64')}`);
        }
        logger.info(`[Photo Preload] 파일에서 기존 사진 ${files.length}건 로드 완료. (${formatMB(getMemoryBytes())}MB)`);

        // 2. UUID 캐시에서 전체 uuid 목록 가져오기 (preloadUserUuids 완료 후이므로 캐시에 다 있음)
        const allUuids = getAllCachedUuids();

        // 3. 파일에 없는 uuid만 필터링
        const missing = allUuids.filter(uuid => !cache.has(uuid));
        logger.info(`[Photo Preload] 신규 사진 필요: ${missing.length}건 (기존 ${cache.size}건)`);

        if (missing.length === 0) {
            logger.info(`[Photo Preload] 완료: 추가 Graph API 호출 없음. 메모리: ${formatMB(getMemoryBytes())}MB`);
            return;
        }

        // 4. Client Credentials 토큰 획득
        const tokenRes = await cca.acquireTokenByClientCredential({
            scopes: ['https://graph.microsoft.com/.default']
        });
        if (!tokenRes?.accessToken) {
            logger.warn('[Photo Preload] 토큰 획득 실패. 사진 프리로드 스킵.');
            return;
        }

        // 5. 사진 다운로드 (1건씩 — 바이너리라 배치 불가)
        let loaded = 0;
        for (const uuid of missing) {
            try {
                const res = await axios.get(
                    `https://graph.microsoft.com/v1.0/users/${uuid}/photos/96x96/$value`,
                    {
                        headers: { Authorization: `Bearer ${tokenRes.accessToken}` },
                        responseType: 'arraybuffer',
                        timeout: 5000
                    }
                );

                const base64 = `data:image/jpeg;base64,${Buffer.from(res.data).toString('base64')}`;
                cache.set(uuid, base64);
                fs.writeFileSync(path.join(PHOTOS_DIR, `${uuid}.jpg`), Buffer.from(res.data));
                loaded++;

            } catch (err: any) {
                if (err.response?.status === 404) continue; // 사진 없는 사용자 — 정상
                if (err.response?.status === 429) {
                    const wait = parseInt(err.response.headers['retry-after'] || '10', 10);
                    logger.warn(`[Photo Preload] Rate limited. ${wait}초 대기...`);
                    await new Promise(r => setTimeout(r, wait * 1000));
                    missing.push(uuid); // 재시도 큐에 추가
                } else {
                    logger.warn(`[Photo Preload] ${uuid} 실패: ${err.message}`);
                }
            }
        }

        logger.info(`[Photo Preload] 완료: 신규 ${loaded}건 저장. 총 ${cache.size}건, 메모리: ${formatMB(getMemoryBytes())}MB`);

    } catch (err) {
        logger.warn(`[Photo Preload] 프리로드 실패 (서비스는 정상 동작): ${err}`);
    }
};

// ── 배치 갱신 (전체 사진 재다운로드) ─────────────────────────────

export const refreshAllPhotos = async (cca: msal.ConfidentialClientApplication): Promise<void> => {
    logger.info('[Photo Refresh] 전체 사진 갱신 시작...');
    cache.clear(); // 기존 캐시 비우기
    await preloadPhotos(cca); // 전체 재로드
    logger.info('[Photo Refresh] 전체 사진 갱신 완료.');
};
