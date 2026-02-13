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
    id: string;
    name: string;
    position: string;
    role: string;
    companyCode: string;
    companyName: string;
    orgId: string;
    department: string;
    orgFullName: string;
    extension: string;
    mobile: string;
    email: string;
    description: string;
}

export interface OrganizationData {
    orgList: OrgData[];
    empList: EmpData[];
}
