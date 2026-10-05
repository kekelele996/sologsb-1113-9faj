import {
  CAPACITY_STATUSES,
  NIGHT_TOTAL_MINUTES,
  type Instrument,
  type ObsApplication,
  type ObsNight,
  type ObsSession,
  type ObsTarget,
  type Telescope,
} from '../types';
import { axisMinutes, durationMinutes, minutesToTime } from './astro';
import { uid } from './id';

/** 当前数据结构版本（与 usePersistentStore.SCHEMA_VERSION 保持一致，避免循环引用在此硬编码） */
const SCHEDULER_SCHEMA_VERSION = 3;

/**
 * 相对 18:00 的夜间轴分钟：中午 12:00 前的时刻视为次日，允许负值（日落早于 18:00 时）。
 * 与 astro.axisMinutes 的区别：axisMinutes 把 18:00 前的傍晚时刻卷到轴尾，这里保留线性偏移，便于求暗时段窗口。
 */
function nightAxis(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((v) => Number(v) || 0);
  const clock = h * 60 + m;
  return clock >= 12 * 60 ? clock - 18 * 60 : clock + 24 * 60 - 18 * 60;
}

/** 观测夜暗时段窗口（夜间轴分钟）：日落 → 日出，裁剪到时间轴范围内 */
export interface DarkWindow {
  start: number;
  end: number;
  /** 暗时段容量（分钟） */
  capacity: number;
}

export function darkWindow(night: Pick<ObsNight, 'sunset' | 'sunrise'>): DarkWindow {
  const start = Math.max(0, Math.min(NIGHT_TOTAL_MINUTES, nightAxis(night.sunset)));
  const end = Math.max(start, Math.min(NIGHT_TOTAL_MINUTES, nightAxis(night.sunrise)));
  return { start, end, capacity: end - start };
}

/** 段在夜间轴上的占用区间（跨零点安全） */
function sessionAxisRange(session: Pick<ObsSession, 'startTime' | 'endTime'>): [number, number] {
  const start = nightAxis(session.startTime);
  let end = nightAxis(session.endTime);
  if (end <= start) end += 1440;
  return [start, end];
}

/** 该夜被有效段占用的分钟数（容量条展示用；已失效与因云取消不占容量） */
export function nightUsedMinutes(nightId: string, sessions: ObsSession[]): number {
  return sessions
    .filter((session) => session.nightId === nightId && CAPACITY_STATUSES.includes(session.status))
    .reduce((sum, session) => sum + durationMinutes(session.startTime, session.endTime), 0);
}

/** 在暗时段窗口内、避开已占用区间，找第一段长度 >= needed 的空档 */
export function findGap(window: DarkWindow, occupied: Array<[number, number]>, needed: number): [number, number] | null {
  const sorted = [...occupied].sort((a, b) => a[0] - b[0]);
  let cursor = window.start;
  for (const [occStart, occEnd] of sorted) {
    if (occEnd <= cursor) continue;
    if (occStart - cursor >= needed) return [cursor, cursor + needed];
    cursor = Math.max(cursor, occEnd);
  }
  if (window.end - cursor >= needed) return [cursor, cursor + needed];
  return null;
}

export interface ScheduleContext {
  applications: ObsApplication[];
  sessions: ObsSession[];
  nights: ObsNight[];
  telescopes: Telescope[];
  instruments: Instrument[];
  targets: ObsTarget[];
}

export interface QueueItem {
  code: string;
  reason: string;
}

export interface SchedulePlan {
  /** 新排入的段（尚未落库） */
  created: ObsSession[];
  /** 当夜容量放不下、顺延排队仍没排上的申请 */
  queued: QueueItem[];
}

/** 申请编号 → 有效段累计分钟（待执行 / 进行中 / 已完成） */
export function effectiveMinutesMap(sessions: ObsSession[]): Map<string, number> {
  const map = new Map<string, number>();
  sessions.forEach((session) => {
    if (!session.applicationId || !CAPACITY_STATUSES.includes(session.status)) return;
    map.set(session.applicationId, (map.get(session.applicationId) ?? 0) + durationMinutes(session.startTime, session.endTime));
  });
  return map;
}

/**
 * 编排台按单排段：
 * - 待编排队列 = 有效段累计不足想拍时长的申请单，按期限、提交时间排序；
 * - 每张单整段排入期限内最早有空档的观测夜（暗时段容量有限，当夜放不下就顺到后面的夜）；
 * - 已确认与已完成的段原样保留，只在剩余空档里排新段，不挤掉任何已有段。
 */
export function buildSchedulePlan(context: ScheduleContext): SchedulePlan {
  const { applications, sessions, nights, telescopes, instruments, targets } = context;
  const effective = effectiveMinutesMap(sessions);

  const pending = applications
    .map((app) => ({ app, remaining: app.requestedMinutes - (effective.get(app.code) ?? 0) }))
    .filter((item) => item.remaining > 0)
    .sort((a, b) => a.app.deadline.localeCompare(b.app.deadline) || a.app.submittedAt.localeCompare(b.app.submittedAt));

  /** nightId__telescopeId → 已占用区间（含本次新排的段，同夜多单排队时互不相撞） */
  const occupied = new Map<string, Array<[number, number]>>();
  sessions
    .filter((session) => CAPACITY_STATUSES.includes(session.status))
    .forEach((session) => {
      const key = `${session.nightId}__${session.telescopeId}`;
      const list = occupied.get(key) ?? [];
      list.push(sessionAxisRange(session));
      occupied.set(key, list);
    });

  const orderedNights = [...nights].sort((a, b) => a.date.localeCompare(b.date));
  const usableTelescopes = telescopes.filter((telescope) => telescope.status === '可用');
  const created: ObsSession[] = [];
  const queued: QueueItem[] = [];

  for (const { app, remaining } of pending) {
    const target = targets.find((item) => item.id === app.targetId);
    if (!target) {
      queued.push({ code: app.code, reason: '目标不存在，无法编排' });
      continue;
    }
    let placed: ObsSession | null = null;
    for (const night of orderedNights) {
      if (night.date > app.deadline) continue;
      const window = darkWindow(night);
      if (window.capacity < remaining) continue;
      for (const telescope of usableTelescopes) {
        const key = `${night.id}__${telescope.id}`;
        const gap = findGap(window, occupied.get(key) ?? [], remaining);
        if (!gap) continue;
        const instrument = instruments.find((item) => item.telescopeCode === telescope.code);
        placed = {
          id: uid('s'),
          nightId: night.id,
          targetId: app.targetId,
          startTime: minutesToTime(gap[0]),
          endTime: minutesToTime(gap[1]),
          telescopeId: telescope.id,
          instrumentId: instrument?.id ?? '',
          filterSlot: target.filter,
          plannedFrames: target.exposureSec > 0 ? Math.round((remaining * 60) / target.exposureSec) : 0,
          status: '待执行',
          applicationId: app.code,
          confirmed: false,
          schemaVersion: SCHEDULER_SCHEMA_VERSION,
        };
        occupied.set(key, [...(occupied.get(key) ?? []), gap]);
        break;
      }
      if (placed) break;
    }
    if (placed) {
      created.push(placed);
    } else {
      queued.push({ code: app.code, reason: '期限内各夜暗时段容量不足，排队等待后续观测夜' });
    }
  }
  return { created, queued };
}
