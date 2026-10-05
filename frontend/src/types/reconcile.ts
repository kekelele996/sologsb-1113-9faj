/** 对账差异类型：两边台账按申请编号对不上的三类情形 */
export type ReconcileIssueKind = '孤儿段' | '漏排单' | '时长不符';

/** 对账差异项（由两边台账派生，不落库；挂起动作才落库） */
export interface ReconcileIssue {
  /** 差异项稳定键（种类 + 引用 id），挂起时以此关联 */
  key: string;
  kind: ReconcileIssueKind;
  /** 涉及的申请编号 */
  applicationCode: string;
  /** 涉及的排程段 ID（孤儿段） */
  sessionId?: string;
  /** 涉及的申请单 ID（漏排单 / 时长不符） */
  applicationId?: string;
  /** 差异说明 */
  detail: string;
}

/** 挂起记录：对不上的差异先挂起，等值班人裁定后解除 */
export interface ReconcileHold {
  id: string;
  /** 关联的差异项键 */
  issueKey: string;
  kind: ReconcileIssueKind;
  applicationCode: string;
  /** 差异说明快照（挂起时的现场） */
  detail: string;
  /** 挂起备注（谁、为什么挂起） */
  note: string;
  /** 挂起时间 ISO 串 */
  createdAt: string;
}

export const RECONCILE_KIND_COLORS: Record<ReconcileIssueKind, 'error' | 'warning' | 'info'> = {
  孤儿段: 'error',
  漏排单: 'warning',
  时长不符: 'info',
};
