/** 排程段状态（已失效：申请单时长改动后未确认的待执行段失效，等重排） */
export type SessionStatus = '待执行' | '进行中' | '已完成' | '因云取消' | '已失效';

/** 观测排程段（编排台台账） */
export interface ObsSession {
  id: string;
  /** 观测夜 ID */
  nightId: string;
  /** 观测目标 ID */
  targetId: string;
  /** 开始时刻 HH:mm */
  startTime: string;
  /** 结束时刻 HH:mm（可跨零点） */
  endTime: string;
  /** 望远镜 ID */
  telescopeId: string;
  /** 终端 ID */
  instrumentId: string;
  /** 滤镜轮位 */
  filterSlot: string;
  /** 计划帧数 */
  plannedFrames: number;
  /** 状态 */
  status: SessionStatus;
  /** 申请编号（对账键；空 = 待认领的历史段） */
  applicationId?: string;
  /** 已确认标记：自动编排与申请单重排都不挤掉已确认的段 */
  confirmed?: boolean;
  /** 改期原因 */
  rescheduleReason?: string;
  /** 替补夜 ID（迁移时补齐） */
  backupNightId?: string;
  /** 数据结构版本 */
  schemaVersion: number;
}

/** 冲突项 */
export interface ConflictItem {
  /** 当前排程段 */
  sessionId: string;
  /** 与之冲突的排程段 */
  otherId: string;
  nightId: string;
  telescopeId: string;
  /** 重叠分钟数 */
  overlapMinutes: number;
  /** 重叠区间文案 */
  overlapText: string;
}

export const SESSION_STATUSES: SessionStatus[] = ['待执行', '进行中', '已完成', '因云取消', '已失效'];

/** 占暗时段容量的状态（已失效、因云取消不再占用望远镜空档） */
export const CAPACITY_STATUSES: SessionStatus[] = ['待执行', '进行中', '已完成'];

/** 5 种状态配色（MUI Chip color） */
export const STATUS_CHIP_COLOR: Record<SessionStatus, 'default' | 'primary' | 'success' | 'error' | 'warning'> = {
  待执行: 'default',
  进行中: 'primary',
  已完成: 'success',
  因云取消: 'error',
  已失效: 'warning',
};
