import { CAPACITY_STATUSES, type ApplicationProgress, type ObsApplication, type ObsNight, type ObsSession, type ReconcileIssue } from '../types';
import { durationMinutes } from './astro';
import { effectiveMinutesMap } from './scheduler';

/** 申请单的有效段累计分钟（待执行 / 进行中 / 已完成；已失效与因云取消不计） */
export function effectiveMinutesFor(code: string, sessions: ObsSession[]): number {
  return sessions
    .filter((session) => session.applicationId === code && CAPACITY_STATUSES.includes(session.status))
    .reduce((sum, session) => sum + durationMinutes(session.startTime, session.endTime), 0);
}

export interface ApplicationProgressInfo {
  progress: ApplicationProgress;
  /** 有效段累计分钟 */
  effective: number;
  /** 距想拍时长还差多少分钟 */
  remaining: number;
}

/** 申请单编排进度：由编排台排程段派生（申请台不另存一份编排状态） */
export function applicationProgress(app: ObsApplication, sessions: ObsSession[]): ApplicationProgressInfo {
  const related = sessions.filter((session) => session.applicationId === app.code && CAPACITY_STATUSES.includes(session.status));
  const effective = related.reduce((sum, session) => sum + durationMinutes(session.startTime, session.endTime), 0);
  const remaining = app.requestedMinutes - effective;
  let progress: ApplicationProgress;
  if (effective <= 0) {
    progress = '待编排';
  } else if (remaining <= 0 && related.every((session) => session.status === '已完成')) {
    progress = '已完成';
  } else if (remaining <= 0) {
    progress = '已排满';
  } else {
    progress = '部分编排';
  }
  return { progress, effective, remaining };
}

/**
 * 两边按申请编号对账：
 * - 孤儿段：排程段引用的编号在申请台不存在；
 * - 漏排单：期限已过、编排台从未排过该单的段；
 * - 时长不符：编排台有该单的段，但有效段累计与想拍时长对不上（含改时长后等重排的中间态）。
 */
export function buildReconcileIssues(applications: ObsApplication[], sessions: ObsSession[], nights: ObsNight[]): ReconcileIssue[] {
  const codes = new Set(applications.map((app) => app.code));
  const issues: ReconcileIssue[] = [];

  sessions
    .filter((session) => session.applicationId && !codes.has(session.applicationId))
    .forEach((session) => {
      issues.push({
        key: `orphan:${session.id}`,
        kind: '孤儿段',
        applicationCode: session.applicationId ?? '',
        sessionId: session.id,
        detail: `排程段 ${session.id}（${session.startTime}-${session.endTime}）引用的申请编号 ${session.applicationId} 在申请台不存在`,
      });
    });

  const lastNightDate = nights.reduce((max, night) => (night.date > max ? night.date : max), '');
  applications.forEach((app) => {
    const anySegment = sessions.some((session) => session.applicationId === app.code);
    const effective = effectiveMinutesFor(app.code, sessions);
    if (!anySegment && lastNightDate && app.deadline < lastNightDate) {
      issues.push({
        key: `missing:${app.code}`,
        kind: '漏排单',
        applicationCode: app.code,
        applicationId: app.id,
        detail: `申请单 ${app.code} 期限 ${app.deadline} 已过，编排台没有任何对应排程段`,
      });
    } else if (anySegment && effective !== app.requestedMinutes) {
      issues.push({
        key: `mismatch:${app.code}`,
        kind: '时长不符',
        applicationCode: app.code,
        applicationId: app.id,
        detail: `申请单 ${app.code} 想拍 ${app.requestedMinutes} 分钟，编排台有效段累计 ${effective} 分钟`,
      });
    }
  });

  return issues;
}

/** 待认领：没有申请编号的排程段（历史数据迁移挂不上的那些） */
export function unclaimedSessions(sessions: ObsSession[]): ObsSession[] {
  return sessions.filter((session) => !session.applicationId);
}

/** 供测试与调试：暴露派生用的累计表 */
export { effectiveMinutesMap };
