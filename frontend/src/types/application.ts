/** 观测申请单（申请台台账）：编号、想拍的曝光时长与期限，编排台只读引用、不可改写 */
export interface ObsApplication {
  id: string;
  /** 申请编号（两边对账的唯一键，如 SQ-20251006-001） */
  code: string;
  /** 观测目标 ID */
  targetId: string;
  /** 想拍的累计曝光时长（分钟） */
  requestedMinutes: number;
  /** 期限 YYYY-MM-DD：编排台只把段排进期限内的观测夜 */
  deadline: string;
  /** 申请人 */
  applicant: string;
  /** 提交时间 ISO 串（同期限时按它排队） */
  submittedAt: string;
  /** 备注 */
  note?: string;
  /** 数据结构版本 */
  schemaVersion: number;
}

/** 申请单编排进度（由编排台排程段派生，申请台不另存一份） */
export type ApplicationProgress = '待编排' | '部分编排' | '已排满' | '已完成';

export const APPLICATION_PROGRESS_COLORS: Record<ApplicationProgress, 'default' | 'primary' | 'success' | 'warning'> = {
  待编排: 'default',
  部分编排: 'warning',
  已排满: 'primary',
  已完成: 'success',
};
