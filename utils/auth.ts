import { Request, Response, NextFunction } from 'express';
import * as msal from '@azure/msal-node';
import { jwtDecode } from 'jwt-decode';
import logger from './logger';

export interface AuthenticatedRequest extends Request {
    userEmail?: string;
    requestId?: string;
    accessToken?: string;
}

/**
 * MS Azure AD SSO 토큰을 검증하고 UPN(이메일)을 추출하는 공통 인증 미들웨어 생성기
 * (모듈 순환 참조를 방지하기 위해 cca 인스턴스를 주입받음)
 */
export const createAuthMiddleware = (cca: msal.ConfidentialClientApplication) => {
    return async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<any> => {
        const requestId = (req as any).requestId || Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 7);
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            logger.warn(`[${requestId}][Auth] 인증 헤더가 없거나 형식이 올바르지 않습니다.`);
            return next({ status: 403, message: '인증 헤더가 없거나 Bearer 형식이 아닙니다.' });
        }

        const ssoToken = authHeader.split(' ')[1];

        // [로컬/Mock 환경 최적화]
        // USE_MOCK_DB가 true이거나 NODE_ENV가 개발 환경인 경우
        // Azure AD 서버와의 OBO 토큰 교환 통신을 생략하고 단순히 JWT 토큰을 디코딩하여 UPN(이메일)만 신뢰해서 추출합니다.
        // 이를 통해 로컬 AAD App Client Secret 갱신 불일치로 인한 400 Bad Request 오류를 완벽히 방지합니다.
        const isLocalDev = process.env.USE_MOCK_DB === 'true' || process.env.NODE_ENV === 'development';

        if (isLocalDev) {
            try {
                const decoded: any = jwtDecode(ssoToken);
                const userEmail = decoded.upn || decoded.unique_name || decoded.email || 'test-user@asung.com';
                req.userEmail = userEmail.toLowerCase();
                req.accessToken = 'mock-access-token';
                logger.info(`[${requestId}][Auth][MOCK_DECODE] 로컬 개발용 JWT 디코딩 우회 성공. 사용자: ${req.userEmail}`);
                return next();
            } catch (decodeErr: any) {
                // ssoToken이 이메일 평문일 경우의 폴백 처리
                if (ssoToken.includes('@')) {
                    req.userEmail = ssoToken.toLowerCase().trim();
                    req.accessToken = 'mock-access-token';
                    logger.info(`[${requestId}][Auth][MOCK_BYPASS] 로컬 이메일 꼼수 우회 성공: ${req.userEmail}`);
                    return next();
                }
                logger.error(`[${requestId}][Auth] JWT 디코딩 에러: ${decodeErr.message}`);
                return next({ status: 401, message: '토큰 디코딩에 실패했습니다.' });
            }
        }

        // OBO(On-Behalf-Of) 토큰 요청을 통한 토큰 유효성 검증
        const oboRequest: msal.OnBehalfOfRequest = {
            oboAssertion: ssoToken,
            scopes: ["User.Read"],
        };

        try {
            logger.info(`[${requestId}][Auth] OBO 토큰 검증 요청...`);
            const response = await cca.acquireTokenOnBehalfOf(oboRequest);

            if (!response || !response.accessToken) {
                logger.warn(`[${requestId}][Auth] OBO 토큰 획득 실패 (유효하지 않은 토큰)`);
                return next({ status: 401, message: '유효하지 않은 토큰입니다.' });
            }

            // 토큰 디코딩을 통한 로그인 사용자 UPN(이메일) 추출
            let userEmail = '';
            try {
                const decoded: any = jwtDecode(ssoToken);
                userEmail = decoded.upn || decoded.unique_name || decoded.email;
                if (!userEmail) {
                    logger.warn(`[${requestId}][Auth] 토큰 클레임 내 UPN/이메일 정보가 누락되었습니다.`);
                    return next({ status: 401, message: '토큰 정보에서 사용자 식별 정보(UPN)를 찾을 수 없습니다.' });
                }
            } catch (decodeErr: any) {
                logger.error(`[${requestId}][Auth] JWT 디코딩 에러: ${decodeErr.message}`);
                return next({ status: 401, message: '토큰 디코딩에 실패했습니다.' });
            }

            // 하위 라우터 및 컨트롤러에서 편리하게 사용할 수 있도록 req.userEmail에 주입
            req.userEmail = userEmail.toLowerCase();
            req.accessToken = response.accessToken;
            logger.info(`[${requestId}][Auth] 인증 성공. 사용자 이메일: ${req.userEmail}`);
            next();

        } catch (error: any) {
            logger.error(`[${requestId}][Auth] 인증 예외 발생: ${error.message}`);
            
            if (error?.errorCode === 'invalid_grant') {
                return next({ status: 401, message: 'SSO 토큰이 만료되었습니다. 재인증이 필요합니다.' });
            }
            
            next(error);
        }
    };
};
