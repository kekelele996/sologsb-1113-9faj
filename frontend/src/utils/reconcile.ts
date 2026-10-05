import type { ObsRequest, RequestStatus } from '../types/request';
import type { ObsSession } from '../types/session';
import { durationMinutes } from './astro';

/** 对账结果分类 */
export type ReconcileKind = 'matched' | 'short' | 'unscheduled' | 'over';

export interface ReconcileItem {
  request: ObsRequest;
  /** 已排分钟（不含失效段） */
  scheduledMinutes: number;
  /** 已完成分钟 */
  completedMinutes: number;
  /** 失效段分钟 */
  invalidatedMinutes: number;
  /** 对账分类 */
  kind: ReconcileKind;
  /** 建议的申请单状态 */
  suggestStatus: RequestStatus;
}

export interface OrphanSessionItem {
  session: ObsSession;
  /** no-request：段没有申请编号（旧数据 / 待认领）；broken-link：段上的申请编号找不到对应申请单 */
  reason: 'no-request' | 'broken-link';
}

export interface ReconcileReport {
  items: ReconcileItem[];
  orphanSessions: OrphanSessionItem[];
  matchedCount: number;
  mismatchCount: number;
  orphanCount: number;
}

function minutesOf(sessions: ObsSession[]): number {
  return sessions.reduce((sum, session) => sum + durationMinutes(session.startTime, session.endTime), 0);
}

/**
 * 两边按申请编号对账：申请单侧报曝光时长，编排单侧报已排分钟。
 * 对不上的（排多了 / 编号悬空）先挂起等人定；排少了属容量不足，建议续排；
 * 没有申请编号的段单列待认领。
 */
export function reconcile(requests: ObsRequest[], sessions: ObsSession[]): ReconcileReport {
  const items: ReconcileItem[] = requests.map((request) => {
    const linked = sessions.filter((session) => session.requestId === request.id);
    const valid = linked.filter((session) => !session.invalidated);
    const scheduledMinutes = minutesOf(valid);
    const completedMinutes = minutesOf(valid.filter((session) => session.status === '已完成'));
    const invalidatedMinutes = minutesOf(linked.filter((session) => session.invalidated));

    let kind: ReconcileKind;
    let suggestStatus: RequestStatus;
    if (scheduledMinutes === 0) {
      kind = 'unscheduled';
      suggestStatus = '待排段';
    } else if (scheduledMinutes < request.exposureMinutes) {
      kind = 'short';
      suggestStatus = '排段中';
    } else if (scheduledMinutes === request.exposureMinutes) {
      kind = 'matched';
      suggestStatus = completedMinutes >= request.exposureMinutes ? '已完成' : '已排段';
    } else {
      kind = 'over';
      suggestStatus = '已挂起'; // 对不上，先挂起等人定
    }
    return { request, scheduledMinutes, completedMinutes, invalidatedMinutes, kind, suggestStatus };
  });

  const orphanSessions: OrphanSessionItem[] = sessions
    .filter((session) => !session.requestId || !requests.some((request) => request.id === session.requestId))
    .map((session) => ({
      session,
      reason: session.requestId ? 'broken-link' : 'no-request',
    }));

  return {
    items,
    orphanSessions,
    matchedCount: items.filter((item) => item.kind === 'matched').length,
    mismatchCount: items.filter((item) => item.kind === 'over').length + orphanSessions.filter((item) => item.reason === 'broken-link').length,
    orphanCount: orphanSessions.length,
  };
}
