export interface OrgData {
    orgId: string;
    orgName: string;
    orgFullName: string;
    orgLevel: number;
    parentId: string;
    sortCode: string;
    companyCode: string;
}

export interface EmpData {
    // id: string;
    // name: string;
    // position: string;
    // role: string;
    // companyCode: string;
    // companyName: string;
    // orgId: string;
    // department: string;
    // orgFullName: string;
    // extension: string;
    // mobile: string;
    // email: string;
    // description: string;
    id: string; // 고유 ID (User Principal Name 또는 GUID) - 프론트엔드용 매핑
    name: string; // 이름
    position: string; // 직위 (e.g. 과장, 대리)
    role: string; // 직책 (e.g. 팀장)
    department: string; // 부서명
    orgFullName: string; // 조직 전체 경로명 
    orgId: string; // 부서 ID (트리 연동용)
    extension: string; // 내선 번호
    mobile: string; // 휴대폰 번호
    email: string; // 이메일 주소
    companyName: string; // 회사명 
    companyCode: string; // 회사 코드 
    description: string; // 담당업무
}

export interface OrganizationData {
    orgList: OrgData[];
    empList: EmpData[];
}
