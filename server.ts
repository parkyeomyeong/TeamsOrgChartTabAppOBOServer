import express, { Request, Response } from 'express';
import * as msal from '@azure/msal-node';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import https from 'https';

import { jwtDecode } from 'jwt-decode';
import { initDB, execute } from './utils/db';
import { GET_ORG_CHART_EMPLOYEES, GET_ORG_CHART_DEPARTMENTS } from './queries/orgChart';
import { EmpData, OrgData } from './types/orgChart';

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
    const start = Date.now();
    const requestId = Math.random().toString(36).substring(7); // 간단한 요청 ID 생성
    console.log(`[REQ-START][${requestId}] ${req.method} ${req.url}`);

    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`[REQ-END][${requestId}] ${req.method} ${req.url} - ${res.statusCode} (${duration}ms)`);
    });

    // req 객체에 id 심어서 다른 곳에서도 쓸 수 있게 (필요시)
    (req as any).requestId = requestId;
    next();
});

// 요청 로깅 미들웨어
app.use((req: Request, res: Response, next) => {
    const now = new Date().toISOString();
    console.log(`[${now}] ${req.method} ${req.url} - IP: ${req.ip}`);
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
app.get('/api/orgChartData', async (req: Request, res: Response): Promise<any> => {
    const requestId = (req as any).requestId;
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        return res.status(401).send('인증 헤더가 없습니다.');
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
            return res.status(401).send('유효하지 않은 토큰입니다.');
        }

        // * 검증 이후 조직도 데이터 가져오기 *
        console.log(`[${requestId}] DB 데이터 조회 시작 (Employee, Organization 순차 수행)...`);

        // [중요] 병렬 실행(Promise.all)은 커넥션을 동시에 2개를 점유하므로, 
        // 동시 접속자가 몰리면 커넥션 풀(Max 10)이 금방 고갈되어 서버가 멈출 수 있습니다.
        // 안정성을 위해 하나씩 실행하고 반납하도록 순차 실행으로 변경합니다.

        const empResult = await execute(GET_ORG_CHART_EMPLOYEES);
        const orgResult = await execute(GET_ORG_CHART_DEPARTMENTS);

        console.log(`[${requestId}] DB 데이터 조회 완료.`);

        // DB에서 조회한 결과를 TypeScript 인터페이스(EmpData, OrgData)로 타입 단언(Type Assertion)하여 사용
        // 이렇게 하면 이후 코드에서 자동완성 및 타입 체크의 도움을 받을 수 있습니다.
        const dbEmpList = empResult.rows as EmpData[];
        const dbOrgList = orgResult.rows as OrgData[];

        res.json({
            orgList: dbOrgList,
            empList: dbEmpList
        });

    } catch (error: any) {
        // 상세 에러 로깅
        console.error("=========================================");
        console.error("Error in /api/orgChartData:");
        console.error("Message:", error.message);
        console.error("Details:", JSON.stringify(error, null, 2));
        console.error("Stack:", error.stack);
        console.error("=========================================");

        res.status(401).send('인증 또는 데이터 조회에 실패했습니다. 서버 로그를 확인해주세요.');
    }
});

// 유저들의 Presence (접속 상태) 일괄 가져오기 (POST)
// Body: { ids: ["email1@test.com", "uuid2", ...] } -> 이메일/UUID 혼용 가능 (자동 변환)
// flow설명 1. email or uuid 로 요청받음 (거의 email로 받을 예정)
// flow설명 2. email로 받은거는 uuid로 변환
// flow설명 3. uuid로 presence 조회
// flow설명 4. 결과를 email로 매칭한 객체로 반환
app.post('/api/users/presence', async (req: Request, res: Response): Promise<any> => {
    const requestId = (req as any).requestId;
    console.log(`[${requestId}] Presence Batch Request Started.`);
    const authHeader = req.headers.authorization;
    const { ids } = req.body;

    if (!authHeader) {
        return res.status(401).send('인증 헤더가 없습니다.');
    }

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(400).send('유효하지 않은 ID 목록입니다.');
    }

    const ssoToken = authHeader.split(' ')[1];

    // 필요한 권한은 Presence 읽기와 유저 ID 조회를 위한 User.Read.All
    const oboRequest: msal.OnBehalfOfRequest = {
        oboAssertion: ssoToken,
        scopes: ["Presence.Read.All", "User.Read.All"],
    };

    try {
        console.log(`[${requestId}] Presence OBO Token 요청...`);
        const response = await cca.acquireTokenOnBehalfOf(oboRequest); // AccessToken 획득
        console.log(`[${requestId}] Presence OBO Token 획득 성공.`);
        if (!response || !response.accessToken) {
            return res.status(401).send('유효하지 않은 토큰입니다.');
        }
        const accessToken = response.accessToken;

        const BATCH_SIZE = 15;
        const allResults: any[] = [];

        // ID 목록을 15개씩 청크로 나누어 처리
        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
            console.log(`[${requestId}] Chunk Processing [${i} - ${i + BATCH_SIZE}]`);
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
                        console.log(`[${requestId}] Graph API User Lookup Request (Email -> UUID)...`);
                        const userLookupResponse = await axios.get(
                            `https://graph.microsoft.com/v1.0/users?$filter=${filterClause}&$select=id,userPrincipalName`,
                            {
                                headers: { Authorization: `Bearer ${accessToken}` },
                                timeout: 5000 // 5초 타임아웃 설정 (무한 대기 방지)
                            }
                        );
                        console.log(`[${requestId}] Graph API User Lookup Response Received.`);

                        const foundUsers = userLookupResponse.data.value;
                        const foundIds = foundUsers.map((u: any) => {
                            userIdToEmailMap.set(u.id, u.userPrincipalName); // ID와 이메일 매핑 저장
                            return u.id;
                        });
                        resolvedUuids = [...resolvedUuids, ...foundIds];

                    } catch (lookupError) {
                        console.error(`Chunk ${i / BATCH_SIZE} User ID lookup failed:`, lookupError);
                        // ID 조회 실패 시 해당 청크의 이메일 기반 조회는 건너뜀 (기존 UUID만으로 진행 시도 가능하지만 복잡성 줄임)
                    }
                }

                if (resolvedUuids.length === 0) {
                    continue; // 조회할 대상이 없으면 다음 청크로
                }

                // 3. 확보된 UUID로 Presence 조회
                console.log(`[${requestId}] Graph API Presence Request...`);
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
                console.log(`[${requestId}] Graph API Presence Response Received.`);

                // 4. 응답 데이터 포맷팅 (이메일 포함) 및 결과 수집
                const presenceList = graphResponse.data.value;
                const formattedChunk = presenceList.map((item: any) => ({
                    email: userIdToEmailMap.get(item.id) || item.id,
                    availability: item.availability,
                    activity: item.activity
                }));

                allResults.push(...formattedChunk);

            } catch (chunkError) {
                console.error(`Error processing chunk starting at index ${i}:`, chunkError);
                // 특정 청크 실패 시 전체 실패가 아닌, 해당 청크만 건너뛰고 계속 진행
            }
        }

        res.json(allResults);

    } catch (error: any) {
        console.error("Batch presence fetch failed:", error.response?.data || error.message);
        res.status(error.response?.status || 500).send(error.response?.data || '서버 내부 오류가 발생했습니다.');
    }
});

// ... (End of routes)

// 404 핸들러 (정의되지 않은 라우트 처리)
app.use((req: Request, res: Response, next) => {
    console.log(`[404 Error] Resource not found: ${req.method} ${req.url}`);
    res.status(404).send('요청하신 리소스를 찾을 수 없습니다.');
});

// 글로벌 에러 핸들러
app.use((err: any, req: Request, res: Response, next: any) => {
    console.error(`[500 Error] Unhandled Server Error: ${err.message}`, err);
    res.status(500).send('서버 내부 오류가 발생했습니다.');
});

// 서버 시작
(async () => {

    try {
        await initDB(); // DB 연결 초기화
        app.listen(port, () => {
            console.log(`Server running at http://localhost:${port}`);
        });
    } catch (err) {
        console.error('Failed to start server due to DB connection error:', err);
        process.exit(1); // DB 연결 실패 시 서버 시작하지 않고 종료
    }
})();
