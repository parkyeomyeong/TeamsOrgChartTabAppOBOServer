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
//
// - preloadPhotos   : 서버 시작 시. 파일에서 복원 + 파일이 없는 uuid만 다운로드
// - refreshAllPhotos: 일일 배치(01:30). 파일 유무와 무관하게 전원 재다운로드
//                     (성공 → 덮어쓰기, 404 → 삭제, 그 외 실패 → 기존 유지)
// ================================================================

const PHOTOS_DIR = path.join(__dirname, '..', 'photos');
const cache = new Map<string, Buffer>(); // uuid → jpeg buffer

const GRAPH_SCOPES = ['https://graph.microsoft.com/.default'];
const photoUrl = (uuid: string) => `https://graph.microsoft.com/v1.0/users/${uuid}/photos/96x96/$value`;
const photoPath = (uuid: string) => path.join(PHOTOS_DIR, `${uuid}.jpg`);

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

// ── 공통: Graph 사진 다운로드 ───────────────────────────────────

type DownloadResult =
    | { status: 'ok'; buf: Buffer }
    | { status: 'notfound' }          // 404 — 사진 없음(삭제됨)
    | { status: 'ratelimited'; wait: number } // 429 — Retry-After 초
    | { status: 'error'; message: string };

const downloadPhoto = async (uuid: string, accessToken: string): Promise<DownloadResult> => {
    try {
        const res = await axios.get(photoUrl(uuid), {
            headers: { Authorization: `Bearer ${accessToken}` },
            responseType: 'arraybuffer',
            timeout: 5000
        });
        return { status: 'ok', buf: Buffer.from(res.data) };
    } catch (err: any) {
        if (err.response?.status === 404) return { status: 'notfound' };
        if (err.response?.status === 429) {
            const wait = parseInt(err.response.headers['retry-after'] || '10', 10);
            return { status: 'ratelimited', wait };
        }
        return { status: 'error', message: err.message };
    }
};

const savePhoto = (uuid: string, buf: Buffer) => {
    cache.set(uuid, buf);
    fs.writeFileSync(photoPath(uuid), buf);
};

const removePhoto = (uuid: string) => {
    cache.delete(uuid);
    fs.rmSync(photoPath(uuid), { force: true });
};

const sleep = (sec: number) => new Promise(r => setTimeout(r, sec * 1000));

const acquireAppToken = async (cca: msal.ConfidentialClientApplication): Promise<string | null> => {
    const tokenRes = await cca.acquireTokenByClientCredential({ scopes: GRAPH_SCOPES });
    return tokenRes?.accessToken || null;
};

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
        const accessToken = await acquireAppToken(cca);
        if (!accessToken) {
            logger.warn('[Photo Preload] 토큰 획득 실패. 스킵.');
            return;
        }

        // 4. 신규 사진 다운로드 (1건씩)
        let loaded = 0;
        for (const uuid of missing) {
            const r = await downloadPhoto(uuid, accessToken);
            if (r.status === 'ok') {
                savePhoto(uuid, r.buf);
                loaded++;
            } else if (r.status === 'ratelimited') {
                logger.warn(`[Photo Preload] Rate limited. ${r.wait}초 대기...`);
                await sleep(r.wait);
                missing.push(uuid);
            } else if (r.status === 'error') {
                logger.warn(`[Photo Preload] ${uuid} 실패: ${r.message}`);
            }
            // notfound → 사진 없는 직원. 스킵.
        }

        logger.info(`[Photo Preload] 완료: 신규 ${loaded}건. 총 ${cache.size}건, 메모리: ${formatMB(getMemoryBytes())}MB`);
    } catch (err) {
        logger.warn(`[Photo Preload] 프리로드 실패 (서비스는 정상 동작): ${err}`);
    }
};

// ── 배치 갱신 (매일 01:30) ──────────────────────────────────────
// 파일 유무와 관계없이 전원 재다운로드.
// 메모리를 미리 비우지 않으므로 다운로드 실패 시에도 기존 사진이 그대로 서빙됨.

export const refreshAllPhotos = async (cca: msal.ConfidentialClientApplication): Promise<void> => {
    try {
        if (!fs.existsSync(PHOTOS_DIR)) fs.mkdirSync(PHOTOS_DIR, { recursive: true });

        const uuids = [...getAllCachedUuids()];
        logger.info(`[Photo Refresh] 전체 사진 갱신 시작: 대상 ${uuids.length}건 (현재 캐시 ${cache.size}건)`);

        const accessToken = await acquireAppToken(cca);
        if (!accessToken) {
            logger.warn('[Photo Refresh] 토큰 획득 실패. 기존 사진 유지.');
            return;
        }

        let updated = 0, removed = 0, failed = 0;
        for (const uuid of uuids) {
            const r = await downloadPhoto(uuid, accessToken);
            if (r.status === 'ok') {
                savePhoto(uuid, r.buf);
                updated++;
            } else if (r.status === 'notfound') {
                // Graph에 사진이 없음 → 삭제한 사람. 옛 사진도 제거.
                if (cache.has(uuid)) removed++;
                removePhoto(uuid);
            } else if (r.status === 'ratelimited') {
                logger.warn(`[Photo Refresh] Rate limited. ${r.wait}초 대기...`);
                await sleep(r.wait);
                uuids.push(uuid);
            } else {
                // 네트워크 오류·타임아웃 등 → 기존 사진 유지
                logger.warn(`[Photo Refresh] ${uuid} 실패 (기존 유지): ${r.message}`);
                failed++;
            }
        }

        logger.info(
            `[Photo Refresh] 전체 사진 갱신 완료: 갱신 ${updated}건, 삭제 ${removed}건, 실패 ${failed}건. ` +
            `총 ${cache.size}건, 메모리: ${formatMB(getMemoryBytes())}MB`
        );
    } catch (err) {
        logger.warn(`[Photo Refresh] 갱신 실패 (기존 사진 유지): ${err}`);
    }
};
