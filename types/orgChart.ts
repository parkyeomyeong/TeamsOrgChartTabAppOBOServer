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
    empId: string;
    empNm: string;
    jobTitleDesc: string;
    jobTitileCd: string;
    posisionDesc: string;
    posisionCd: string;
    compCd: string;
    orgId: string;
    orgNm: string;
    offcTelNo: string;
    moblTelNo: string;
    emailAddr: string;
}

export interface OrganizationData {
    orgList: OrgData[];
    empList: EmpData[];
}
