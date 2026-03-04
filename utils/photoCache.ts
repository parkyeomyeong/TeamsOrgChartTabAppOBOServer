import fs from 'fs';
import path from 'path';
import axios from 'axios';
import * as msal from '@azure/msal-node';
import logger from './logger';
import { getUuidByEmail, getAllCachedUuids } from './userIdCache';

// ================================================================
// 프로필 사진 캐시 (인메모리 Buffer + 파일시스템)
// L1: Map<uuid, Buffer> — 런타임 서빙 (GET /api/users/photo/:email)
// L2: photos/{uuid}.jpg — 서버 재시작 복구용
// ================================================================

const PHOTOS_DIR = path.join(__dirname, '..', 'photos');
const cache = new Map<string, Buffer>(); // uuid → jpeg buffer

// ── 조회 ────────────────────────────────────────────────────────

/** 이메일로 사진 Buffer 반환 (email → uuid → buffer) */
export const getPhotoBuffer = (email: string): Buffer | null => {
    const uuid = getUuidByEmail(email);
    return uuid ? (cache.get(uuid) || null) : null;
};

// ── 메모리 통계 ─────────────────────────────────────────────────

const getMemoryBytes = (): number => {
    let bytes = 0;
    for (const [k, v] of cache) bytes += k.length * 2 + v.byteLength;
    return bytes;
};
const formatMB = (bytes: number) => (bytes / 1024 / 1024).toFixed(2);

// ── 프리로드 (서버 시작 시) ─────────────────────────────────────

export const preloadPhotos = async (cca: msal.ConfidentialClientApplication): Promise<void> => {
    try {
        if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

        // 1. 파일시스템에서 기존 사진 로드
        const files = fs.readdirSync(PHOTOS_DIR).filter(f => f.endsWith('.jpg'));
        for (const file of files) {
            const uuid = path.basename(file, '.jpg');
            cache.set(uuid, fs.readFileSync(path.join(PHOTOS_DIR, file)));
        }
        logger.info(`[Photo Preload] 파일에서 기존 사진 ${files.length}건 로드. (${formatMB(getMemoryBytes())}MB)`);

        // 2. UUID 캐시에서 전체 목록 → 파일에 없는 것만 필터
        const allUuids = getAllCachedUuids();
        const missing = allUuids.filter(uuid => !cache.has(uuid));
        logger.info(`[Photo Preload] 신규 사진 필요: ${missing.length}건 (기존 ${cache.size}건)`);

        if (missing.length === 0) {
            logger.info(`[Photo Preload] 완료. 메모리: ${formatMB(getMemoryBytes())}MB`);
            return;
        }

        // 3. Client Credentials 토큰 획득
        const tokenRes = await cca.acquireTokenByClientCredential({
            scopes: ['https://graph.microsoft.com/.default']
        });
        if (!tokenRes?.accessToken) {
            logger.warn('[Photo Preload] 토큰 획득 실패. 스킵.');
            return;
        }

        // 4. 신규 사진 다운로드 (1건씩)
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
                const buf = Buffer.from(res.data);
                cache.set(uuid, buf);
                fs.writeFileSync(path.join(PHOTOS_DIR, `${uuid}.jpg`), buf);
                loaded++;
            } catch (err: any) {
                if (err.response?.status === 404) continue;
                if (err.response?.status === 429) {
                    const wait = parseInt(err.response.headers['retry-after'] || '10', 10);
                    logger.warn(`[Photo Preload] Rate limited. ${wait}초 대기...`);
                    await new Promise(r => setTimeout(r, wait * 1000));
                    missing.push(uuid);
                } else {
                    logger.warn(`[Photo Preload] ${uuid} 실패: ${err.message}`);
                }
            }
        }

        logger.info(`[Photo Preload] 완료: 신규 ${loaded}건. 총 ${cache.size}건, 메모리: ${formatMB(getMemoryBytes())}MB`);
    } catch (err) {
        logger.warn(`[Photo Preload] 프리로드 실패 (서비스는 정상 동작): ${err}`);
    }
};

// ── 배치 갱신 ───────────────────────────────────────────────────

export const refreshAllPhotos = async (cca: msal.ConfidentialClientApplication): Promise<void> => {
    logger.info('[Photo Refresh] 전체 사진 갱신 시작...');
    cache.clear();
    await preloadPhotos(cca);
    logger.info('[Photo Refresh] 전체 사진 갱신 완료.');
};
