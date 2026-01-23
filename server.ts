import express, { Request, Response } from 'express';
import * as msal from '@azure/msal-node';
import axios from 'axios';
import cors from 'cors';
import dotenv from 'dotenv';
import { orgList } from './data/orgDummyData';
import { empList } from './data/empDummyData';
import { jwtDecode } from 'jwt-decode';

// 환경 변수 설정 로드
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// 미들웨어 설정
app.use(cors({
    origin: true,       // 모든 도메인 허용 (나중엔 특정 도메인으로 변경해야함)
    credentials: true,  // 인증 정보 포함 허용
    maxAge: 3600        // 핵심: "3600초(1시간) 동안은 Preflight 안하도록 설정"
}));
app.use(express.json()); // JSON 요청 본문 파싱

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

app.get('/api/healthcheck', async (req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// SSO 토큰 디코딩하여 유저 정보 반환
app.get('/api/me', async (req: Request, res: Response): Promise<any> => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        return res.status(401).send('인증 헤더가 없습니다.');
    }

    const ssoToken = authHeader.split(' ')[1];

    try {
        // JWT 토큰 디코딩 (검증은 위임하거나 별도 로직 필요, 여기선 정보 추출용)
        const decodedToken = jwtDecode(ssoToken);
        res.json(decodedToken);
    } catch (error) {
        console.error("Token decoding failed:", error);
        res.status(400).send('유효하지 않은 토큰입니다.');
    }
});

// 조직도 데이터를 가져오는 엔드포인트 (SSO 인증 필요)
app.get('/api/orgChartData', async (req: Request, res: Response): Promise<any> => {
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

        // 인증 성공 시 조직도 데이터 반환
        res.json({
            orgList,
            empList
        });

    } catch (error) {
        console.error("Token validation failed:", error);
        res.status(401).send('인증에 실패했습니다.');
    }
});


// OBO (On-Behalf-Of) 흐름을 처리하는 엔드포인트
// 클라이언트(Teams Tab App)로부터 받은 SSO 토큰을 사용하여 Graph API 액세스 토큰을 획득.
app.post('/api/token', async (req: Request, res: Response): Promise<any> => {
    const authHeader = req.headers.authorization;

    // Authorization 헤더 확인
    if (!authHeader) {
        return res.status(401).send('인증 헤더가 없습니다.');
    }

    // "Bearer <token>" 형식에서 토큰 추출
    const ssoToken = authHeader.split(' ')[1];

    // OBO 요청 객체 생성
    const oboRequest: msal.OnBehalfOfRequest = {
        oboAssertion: ssoToken,
        scopes: ["User.Read"], // 필요한 권한 스코프
    };

    try {
        // MSAL을 사용하여 OBO 흐름으로 액세스 토큰 획득
        const response = await cca.acquireTokenOnBehalfOf(oboRequest);

        if (!response || !response.accessToken) {
            return res.status(500).send('액세스 토큰 획득에 실패했습니다.');
        }

        // 획득한 액세스 토큰으로 Microsoft Graph API 호출 (/me 엔드포인트)
        const graphResponse = await axios.get('https://graph.microsoft.com/v1.0/me', {
            headers: {
                Authorization: `Bearer ${response.accessToken}`
            }
        });

        // 클라이언트에 결과 반환 (Graph API 데이터 및 액세스 토큰)
        res.json({
            userInfo: graphResponse.data,
            accessToken: response.accessToken
        });

    } catch (error) {
        console.error("Error acquiring token:", error);
        res.status(500).send(error);
    }
});

// 유저들의 Presence (접속 상태) 일괄 가져오기 (POST)
// Body: { ids: ["email1@test.com", "uuid2", ...] } -> 이메일/UUID 혼용 가능 (자동 변환)
// flow설명 1. email or uuid 로 요청받음
// flow설명 2. email로 받은거는 uuid로 변환
// flow설명 3. uuid로 presence 조회
// flow설명 4. 결과를 email로 매칭한 객체로 반환
app.post('/api/users/presence', async (req: Request, res: Response): Promise<any> => {
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
        const response = await cca.acquireTokenOnBehalfOf(oboRequest); // AccessToken 획득
        if (!response || !response.accessToken) {
            return res.status(401).send('유효하지 않은 토큰입니다.');
        }
        const accessToken = response.accessToken;

        const BATCH_SIZE = 15;
        const allResults: any[] = [];

        // ID 목록을 15개씩 청크로 나누어 처리
        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
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
                        const userLookupResponse = await axios.get(
                            `https://graph.microsoft.com/v1.0/users?$filter=${filterClause}&$select=id,userPrincipalName`,
                            {
                                headers: { Authorization: `Bearer ${accessToken}` }
                            }
                        );

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
                const graphResponse = await axios.post(
                    `https://graph.microsoft.com/v1.0/communications/getPresencesByUserId`,
                    { ids: resolvedUuids },
                    {
                        headers: {
                            Authorization: `Bearer ${accessToken}`,
                            "Content-Type": "application/json"
                        }
                    }
                );

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

// 특정 유저의 프로필 사진 가져오기
app.get('/api/user/:id/photo', async (req: Request, res: Response): Promise<any> => {
    const authHeader = req.headers.authorization;
    const userId = req.params.id;

    if (!authHeader) {
        return res.status(401).send('인증 헤더가 없습니다.');
    }

    const ssoToken = authHeader.split(' ')[1];

    // OBO 요청을 위한 Scopes (User.ReadBasic.All 또는 User.Read.All 필요)
    const oboRequest: msal.OnBehalfOfRequest = {
        oboAssertion: ssoToken,
        scopes: ["User.ReadBasic.All"],
    };

    try {
        const response = await cca.acquireTokenOnBehalfOf(oboRequest);

        if (!response || !response.accessToken) {
            return res.status(401).send('유효하지 않은 토큰입니다.');
        }

        // Graph API 호출 (이미지 바이너리 응답 필요)
        const graphResponse = await axios.get(
            `https://graph.microsoft.com/v1.0/users/${userId}/photo/$value`,
            {
                headers: {
                    Authorization: `Bearer ${response.accessToken}`
                },
                responseType: 'arraybuffer' // 중요: 이미지는 바이너리로 받아야 함
            }
        );

        // 이미지 헤더 설정 및 전송
        res.setHeader('Content-Type', graphResponse.headers['content-type']);
        res.send(graphResponse.data);

    } catch (error: any) {
        // 사진이 없는 경우 404가 뜰 수 있음
        if (error.response?.status === 404) {
            return res.status(404).send('프로필 사진이 없습니다.');
        }
        console.error("Photo fetch failed:", error.response?.data || error.message);
        res.status(error.response?.status || 500).send(error.response?.data || '서버 내부 오류가 발생했습니다.');
    }
});

// 서버 시작
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});
