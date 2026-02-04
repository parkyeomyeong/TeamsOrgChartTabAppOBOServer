import express, { Request, Response, NextFunction } from 'express';
import * as msal from '@azure/msal-node';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import https from 'https';

import { jwtDecode } from 'jwt-decode';
import { initDB, execute } from './utils/db';
import { GET_ORG_CHART_EMPLOYEES, GET_ORG_CHART_DEPARTMENTS } from './queries/orgChart';
import { EmpData, OrgData } from './types/orgChart';
import logger from './utils/logger';

// 환경 변수 설정 로드
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// [중요] Axios용 HTTPS Agent 설정 (소켓 고갈 방지)
const httpsAgent = new https.Agent({
    keepAlive: true, // 한번 연결한 통로는 안끊고 재사용(통로 새로 만들때마다 시간 소요 큼)
    maxSockets: 100, // 동시 연결 수 제한 (기본값은 무제한이나, OS 제한에 걸릴 수 있음)
    maxFreeSockets: 10, // 장시간 외부 요청 없어도 대기할 소켓 수
    timeout: 5000 // 최대 5초까지만 대기
});

// Axios 전역 설정에 Agent 적용
axios.defaults.httpsAgent = httpsAgent;

// 미들웨어 설정
app.use(cors()); // CORS 허용 (프로덕션 환경에서는 특정 도메인만 허용하도록 수정 필요)
app.use(express.json()); // JSON 요청 본문 파싱

// 요청 시작/종료 로깅 미들웨어
app.use((req, res, next) => {
    // 날짜 포맷팅 헬퍼 (KST One-liner)
    const getKST = () => new Date().toLocaleString('ko-KR', {
        timeZone: 'Asia/Seoul', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).replace(/\. /g, '-').replace('.', '');

    const startTime = new Date(); // Duration 계산용
    const startStr = getKST(); // 로그 출력용

    // <Log추적ID> Snowflake 스타일 (문자열 혼합형)
    // 예: kz3x91a-5k9a1 (앞쪽은 시간 기반 Base36이라 정렬됨, 적당히 짧고 가독성 좋음)
    const requestId = Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 7);

    // <Log추적ID> 토큰에서 사용자 정보(UPN/Name) 추출
    let userPrincipal = 'Guest';
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
        try {
            const token = req.headers.authorization.split(' ')[1];
            const decoded: any = jwtDecode(token);
            userPrincipal = decoded.upn || decoded.name || decoded.sub || 'Unknown';
        } catch (e) {
            userPrincipal = 'InvalidToken';
        }
    }

    res.on('finish', () => { //res.send(), res.json()이 호출되면 이 함수를 거쳐 clien에게 전송!
        // 2. 요청 종료 시간 및 소요 시간 계산
        const endTime = new Date();
        const endStr = getKST();
        const duration = endTime.getTime() - startTime.getTime();

        // [User Request Log] Clean Format
        logger.http(`[${startStr} - ${endStr}][${requestId}][User:${userPrincipal}] ${req.method} ${req.url} - ${res.statusCode} (${duration}ms)`);
    });

    (req as any).requestId = requestId;
    (req as any).userPrincipal = userPrincipal; // [추가] Global Error Handler에서도 누군지 알 수 있게 req에 붙임
    next();
});

// 요청 로깅 미들웨어
app.use((req: Request, res: Response, next) => {
    const now = new Date().toISOString();
    // logger가 이미 시간을 찍어주므로 이중 출력 방지를 위해 제거하거나 debug 레벨로 변경
    // logger.info(`${req.method} ${req.url} - IP: ${req.ip}`); 
    next();
});

// MSAL 설정 (Azure AD 인증을 위한 설정)
const msalConfig: msal.Configuration = {
    auth: {
        clientId: process.env.CLIENT_ID as string, // Azure AD 앱 클라이언트 ID
        authority: `https://login.microsoftonline.com/${process.env.TENANT_ID}`, // 테넌트 ID를 포함한 인증 URL
        clientSecret: process.env.CLIENT_SECRET as string, // Azure AD 앱 클라이언트 시크릿
    }
};

// ConfidentialClientApplication 인스턴스 생성 (서버 사이드 앱용)
const cca = new msal.ConfidentialClientApplication(msalConfig);

// health check
app.get('/api/healthcheck', async (req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});


// 조직도 데이터를 가져오는 엔드포인트 (SSO 인증 필요)
// 조직도 데이터를 가져오는 엔드포인트 (SSO 인증 필요)
app.get('/api/orgChartData', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    const requestId = (req as any).requestId;
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        // [수정] 401 에러도 Global Handler로 위임
        return next({ status: 401, message: '인증 헤더가 없습니다.' });
    }

    const ssoToken = authHeader.split(' ')[1];

    // OBO 요청을 통해 유효한 토큰인지 검증 (Microsoft Graph 호출을 통해 검증)
    // 실제로는 토큰 자체의 서명만 검증해도 되지만, 여기서는 OBO 흐름을 타서 유효성을 확실히 체크함.
    const oboRequest: msal.OnBehalfOfRequest = {
        oboAssertion: ssoToken,
        scopes: ["User.Read"],
    };

    try {
        const response = await cca.acquireTokenOnBehalfOf(oboRequest);

        if (!response || !response.accessToken) {
            return next({ status: 401, message: '유효하지 않은 토큰입니다.' });
        }

        // * 검증 이후 조직도 데이터 가져오기 *
        logger.info(`[${requestId}] DB 데이터 조회 시작 (Employee, Organization 순차 수행)...`);

        // [중요] 병렬 실행(Promise.all)은 커넥션을 동시에 2개를 점유하므로, 
        // 동시 접속자가 몰리면 커넥션 풀(Max 10)이 금방 고갈되어 서버가 멈출 수 있습니다.
        // 안정성을 위해 하나씩 실행하고 반납하도록 순차 실행으로 변경합니다.

        const empResult = await execute(GET_ORG_CHART_EMPLOYEES, [], {}, requestId);
        const orgResult = await execute(GET_ORG_CHART_DEPARTMENTS, [], {}, requestId);

        logger.info(`[${requestId}] DB 데이터 조회 완료.`);

        // DB에서 조회한 결과를 TypeScript 인터페이스(EmpData, OrgData)로 타입 단언(Type Assertion)하여 사용
        // 이렇게 하면 이후 코드에서 자동완성 및 타입 체크의 도움을 받을 수 있습니다.
        const dbEmpList = empResult.rows as EmpData[];
        const dbOrgList = orgResult.rows as OrgData[];

        res.json({
            orgList: dbOrgList,
            empList: dbEmpList
        });

    } catch (error: any) {
        // [수정] 모든 에러 처리를 Global Handler로 위임
        next(error);
    }
});

// 유저들의 Presence (접속 상태) 일괄 가져오기 (POST)
// Body: { ids: ["email1@test.com", "uuid2", ...] } -> 이메일/UUID 혼용 가능 (자동 변환)
// flow설명 1. email or uuid 로 요청받음 (거의 email로 받을 예정)
// flow설명 2. email로 받은거는 uuid로 변환
// flow설명 3. uuid로 presence 조회
// flow설명 4. 결과를 email로 매칭한 객체로 반환
// flow설명 4. 결과를 email로 매칭한 객체로 반환
app.post('/api/users/presence', async (req: Request, res: Response, next: NextFunction): Promise<any> => {
    const requestId = (req as any).requestId;
    logger.info(`[${requestId}] Presence Batch Request Started.`);
    const authHeader = req.headers.authorization;
    const { ids } = req.body;

    if (!authHeader) {
        return next({ status: 401, message: '인증 헤더가 없습니다.' });
    }

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return next({ status: 400, message: '유효하지 않은 ID 목록입니다.' });
    }

    const ssoToken = authHeader.split(' ')[1];

    // 필요한 권한은 Presence 읽기와 유저 ID 조회를 위한 User.Read.All
    const oboRequest: msal.OnBehalfOfRequest = {
        oboAssertion: ssoToken,
        scopes: ["Presence.Read.All", "User.Read.All"],
    };

    try {
        logger.info(`[${requestId}] Presence OBO Token 요청...`);
        const response = await cca.acquireTokenOnBehalfOf(oboRequest); // AccessToken 획득
        logger.info(`[${requestId}] Presence OBO Token 획득 성공.`);
        if (!response || !response.accessToken) {
            return next({ status: 401, message: '유효하지 않은 토큰입니다.' });
        }
        const accessToken = response.accessToken;

        const BATCH_SIZE = 15;
        const allResults: any[] = [];

        // ID 목록을 15개씩 청크로 나누어 처리
        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
            logger.info(`[${requestId}] Chunk Processing [${i} - ${i + BATCH_SIZE}]`);
            const chunkIds = ids.slice(i, i + BATCH_SIZE);

            try {
                // 1. Chunk 내에서 이메일과 UUID 분리
                const emailIds = chunkIds.filter((id: string) => id.includes('@'));
                const uuidIds = chunkIds.filter((id: string) => !id.includes('@'));

                let resolvedUuids: string[] = [...uuidIds];

                // UUID -> Email 매핑을 위한 맵
                const userIdToEmailMap = new Map<string, string>();

                // 2. 이메일이 있다면 UUID로 변환 (Graph API $filter 사용)
                if (emailIds.length > 0) {
                    const filterClause = emailIds.map((email: string) => `userPrincipalName eq '${email}'`).join(' or ');

                    try {
                        logger.info(`[${requestId}] Graph API User Lookup Request (Email -> UUID)...`);
                        const userLookupResponse = await axios.get(
                            `https://graph.microsoft.com/v1.0/users?$filter=${filterClause}&$select=id,userPrincipalName`,
                            {
                                headers: { Authorization: `Bearer ${accessToken}` },
                                timeout: 5000 // 5초 타임아웃 설정 (무한 대기 방지)
                            }
                        );
                        logger.info(`[${requestId}] Graph API User Lookup Response Received.`);

                        const foundUsers = userLookupResponse.data.value;
                        const foundIds = foundUsers.map((u: any) => {
                            userIdToEmailMap.set(u.id, u.userPrincipalName); // ID와 이메일 매핑 저장
                            return u.id;
                        });
                        resolvedUuids = [...resolvedUuids, ...foundIds];

                    } catch (lookupError) {
                        logger.error(`[${requestId}] Chunk ${i / BATCH_SIZE} User ID lookup failed: ${lookupError}`);
                        // ID 조회 실패 시 해당 청크의 이메일 기반 조회는 건너뜀 (기존 UUID만으로 진행 시도 가능하지만 복잡성 줄임)
                    }
                }

                if (resolvedUuids.length === 0) {
                    continue; // 조회할 대상이 없으면 다음 청크로
                }

                // 3. 확보된 UUID로 Presence 조회
                logger.info(`[${requestId}] Graph API Presence Request...`);
                const graphResponse = await axios.post(
                    `https://graph.microsoft.com/v1.0/communications/getPresencesByUserId`,
                    { ids: resolvedUuids },
                    {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            "Content-Type": "application/json"
                        },
                        timeout: 5000 // 5초 타임아웃 설정
                    }
                );
                logger.info(`[${requestId}] Graph API Presence Response Received.`);

                // 4. 응답 데이터 포맷팅 (이메일 포함) 및 결과 수집
                const presenceList = graphResponse.data.value;
                const formattedChunk = presenceList.map((item: any) => ({
                    email: userIdToEmailMap.get(item.id) || item.id,
                    availability: item.availability,
                    activity: item.activity
                }));

                allResults.push(...formattedChunk);

            } catch (chunkError) {
                logger.error(`[${requestId}] Error processing chunk starting at index ${i}: ${chunkError}`);
                // 특정 청크 실패 시 전체 실패가 아닌, 해당 청크만 건너뜀
            }
        }

        res.json(allResults);

    } catch (error: any) {
        // [수정] 모든 에러 처리를 Global Handler로 위임
        next(error);
    }
});

// ... (End of routes)

// 404 핸들러 (정의되지 않은 라우트 처리)
app.use((req: Request, res: Response, next) => {
    logger.warn(`[404 Error] Resource not found: ${req.method} ${req.url}`);
    res.status(404).send('요청하신 리소스를 찾을 수 없습니다.');
});

// 글로벌 에러 핸들러 (Spring에서 @ControllerAdvice(?) 역할)
app.use((err: any, req: Request, res: Response, next: any) => {
    const requestId = (req as any).requestId;
    const userPrincipal = (req as any).userPrincipal || 'Unknown'; // [추가] 유저 정보 가져오기

    // 1. 상태 코드 결정 (에러 객체에 status가 있으면 쓰고, 없으면 500)
    const status = err.status || 500;

    // 2. 에러 로그 (Request ID 포함)
    logger.error(`[START][${requestId}]=========================================`);
    logger.error(`[GlobalHandler] 요청 정보: ${req.method} ${req.url}`);
    logger.error(`[GlobalHandler] 요청 사용자: ${userPrincipal}`); // [추가] 누가 에러 냈는지 기록
    logger.error(`[GlobalHandler] ${status} Error: ${err.message}`);

    // [Stack Trace] 에러가 발생한 정확한 위치(파일명, 줄번호)와 함수 호출 순서를 기록함
    // 예: "at orgChartData (server.ts:150:15)" 처럼 나옴 -> 디버깅의 핵심 단서 (블랙박스 역할)
    if (err.stack) {
        logger.error(`[Stack Info] \n${err.stack}`);
    }
    logger.error(`[END][${requestId}]=========================================`);

    // 3. 클라이언트 응답 (JSON 포맷)
    res.status(status).json({
        success: false,
        requestId: requestId, // 클라이언트가 이 ID로 문의하면 로그 찾기 쉬움
        message: status === 500 ? '서버 내부 오류가 발생했습니다.' : err.message
    });
});

// 서버 시작
(async () => {

    try {
        await initDB(); // DB 연결 초기화
        app.listen(port, () => {
            logger.info(`Server running at http://localhost:${port}`);
        });
    } catch (err) {
        console.error('Failed to start server due to DB connection error:', err);
        process.exit(1); // DB 연결 실패 시 서버 시작하지 않고 종료
    }
})();
