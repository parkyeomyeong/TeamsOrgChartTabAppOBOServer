import express, { Router, Response, NextFunction } from 'express';
import * as msal from '@azure/msal-node';
import { createAuthMiddleware, AuthenticatedRequest } from '../utils/auth';
import { favoritesRepository } from '../repositories/favoritesRepository';

/**
 * 즐겨찾기 API 라우터 생성기
 * (ConfidentialClientApplication를 주입받아 공통 SSO 인증 미들웨어를 구성)
 */
export const createFavoritesRouter = (cca: msal.ConfidentialClientApplication): Router => {
    const router = express.Router();
    const authenticate = createAuthMiddleware(cca);

    // 헬퍼: 요청에서 userEmpId 추출 및 HR 등록 여부 검증
    const validateUserEmpId = (req: AuthenticatedRequest, next: NextFunction): string | null => {
        const userEmpId = (req.headers['x-user-empid'] as string || req.query.userEmpId as string || req.body.userEmpId as string || '').trim();
        
        if (!userEmpId) {
            next({ 
                status: 400, 
                message: 'HR 시스템에 사원 정보가 등록되어 있지 않습니다. 사번(empId) 정보가 유효하지 않습니다.' 
            });
            return null;
        }
        return userEmpId;
    };

    /**
     * 1. GET /api/favorites : 로그인 유저의 즐겨찾기 리스트 조회
     */
    router.get('/', authenticate, async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<any> => {
        const requestId = (req as any).requestId;
        const userEmpId = validateUserEmpId(req, next);
        if (!userEmpId) return;

        try {
            const favorites = await favoritesRepository.getFavorites(userEmpId, requestId);
            res.json(favorites);
        } catch (err) {
            next(err);
        }
    });

    /**
     * 2. POST /api/favorites : 특정 사원 즐겨찾기 등록
     */
    router.post('/', authenticate, async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<any> => {
        const requestId = (req as any).requestId;
        const userEmpId = validateUserEmpId(req, next);
        if (!userEmpId) return;

        const { targetEmpId } = req.body;

        if (!targetEmpId || typeof targetEmpId !== 'string' || !targetEmpId.trim()) {
            return next({ status: 400, message: '올바른 대상 사원 ID(targetEmpId) 정보가 필요합니다.' });
        }

        try {
            const newFavorite = await favoritesRepository.addFavorite(userEmpId, targetEmpId.trim(), requestId);
            res.status(201).json({
                success: true,
                message: '즐겨찾기 등록 완료',
                data: newFavorite
            });
        } catch (err) {
            next(err);
        }
    });

    /**
     * 3. DELETE /api/favorites/:targetEmpId : 즐겨찾기 해제
     */
    router.delete('/:targetEmpId', authenticate, async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<any> => {
        const requestId = (req as any).requestId;
        const userEmpId = validateUserEmpId(req, next);
        if (!userEmpId) return;

        const targetEmpId = req.params.targetEmpId as string;

        if (!targetEmpId || typeof targetEmpId !== 'string' || !targetEmpId.trim()) {
            return next({ status: 400, message: '올바르지 않은 대상 사원 ID 정보입니다.' });
        }

        try {
            await favoritesRepository.removeFavorite(userEmpId, targetEmpId.trim(), requestId);
            res.json({
                success: true,
                message: '즐겨찾기 해제 완료'
            });
        } catch (err) {
            next(err);
        }
    });

    return router;
};
