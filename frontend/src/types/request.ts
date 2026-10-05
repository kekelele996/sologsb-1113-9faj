/** 申请单状态 */
export type RequestStatus = '待排段' | '排段中' | '已排段' | '已完成' | '已挂起' | '排段失败';

/** 观测申请单（申请台侧数据：编号、想拍的曝光时长、期限） */
export interface ObsRequest {
  id: string;
  /** 申请编号（对外编号，如 SQ-2025-001） */
  code: string;
  /** 观测目标 ID */
  targetId: string;
  /** 想拍的曝光时长（分钟） */
  exposureMinutes: number;
  /** 期限 YYYY-MM-DD */
  deadline: string;
  /** 状态 */
  status: RequestStatus;
  /** 已重试次数 */
  retryCount: number;
  /** 最近一次失败原因 */
  lastError?: string;
  /** 建单时间 ISO */
  createdAt: string;
  /** 备注 */
  remark?: string;
  /** 数据结构版本 */
  schemaVersion: number;
}

export const REQUEST_STATUSES: RequestStatus[] = ['待排段', '排段中', '已排段', '已完成', '已挂起', '排段失败'];

/** 申请单状态配色（MUI Chip color） */
export const REQUEST_STATUS_COLOR: Record<RequestStatus, 'default' | 'primary' | 'secondary' | 'success' | 'warning' | 'error'> = {
  待排段: 'default',
  排段中: 'primary',
  已排段: 'success',
  已完成: 'success',
  已挂起: 'warning',
  排段失败: 'error',
};
