import { NIGHT_TOTAL_MINUTES, type ObsNight } from '../types/night';
import type { ObsRequest } from '../types/request';
import type { ObsSession } from '../types/session';
import type { ObsTarget } from '../types/target';
import type { Telescope } from '../types/equipment';
import { axisMinutes, durationMinutes, minutesToTime } from './astro';
import { uid } from './id';
import { SCHEMA_VERSION } from '../hooks/usePersistentStore';

/** 单个排程段的标准时长（分钟）：申请单曝光时长按此切块，最后一块可小 */
export const CHUNK_MINUTES = 60;

/** 暗时段容量（分钟/夜/望远镜）：18:00 → 次日 06:00 */
export const DARK_MINUTES = NIGHT_TOTAL_MINUTES;

export interface PlanResult {
  /** 新排入的排程段（已按夜、望远镜归置到空档） */
  sessions: ObsSession[];
  /** 已排分钟（不含已完成段） */
  scheduledMinutes: number;
  /** 因容量不足未排上的分钟（排队顺到后面的夜，直到期限） */
  remainderMinutes: number;
  /** 用到的观测夜 id 列表 */
  usedNightIds: string[];
}

/** 某夜某望远镜上已被占用的区间（分钟轴，18:00 起算） */
function occupiedIntervals(nightId: string, telescopeId: string, sessions: ObsSession[]): Array<[number, number]> {
  return sessions
    .filter((session) => session.nightId === nightId && session.telescopeId === telescopeId && !session.invalidated)
    .map((session) => {
      const start = axisMinutes(session.startTime);
      let end = axisMinutes(session.endTime);
      if (end <= start) end += 1440;
      return [start, end] as [number, number];
    })
    .sort((a, b) => a[0] - b[0]);
}

/** 在暗时段内找第一个能容纳 durationMin 的空档（不挤掉已确认的段） */
function findGap(intervals: Array<[number, number]>, durationMin: number): number | null {
  const lo = 0;
  const hi = NIGHT_TOTAL_MINUTES;
  let cursor = lo;
  for (const [start, end] of intervals) {
    if (start - cursor >= durationMin) return cursor;
    if (end > cursor) cursor = end;
  }
  if (hi - cursor >= durationMin) return cursor;
  return null;
}

/**
 * 编排台按单排段：把申请单的曝光时长切块，按观测夜顺序、望远镜顺序找空档排入。
 * 每夜暗时段容量有限，满了就排队顺到后面的夜；不挤掉已确认的段（已完成 / 待执行）。
 * 失效段（invalidated）不占容量，等重排。
 */
export function planRequest(
  request: ObsRequest,
  nights: ObsNight[],
  sessions: ObsSession[],
  telescopes: Telescope[],
  target: ObsTarget | undefined,
  instruments: Array<{ id: string; telescopeCode: string }>,
): PlanResult {
  const result: ObsSession[] = [];
  const usedNightIds = new Set<string>();

  // 已完成的段不再重复排
  const completedMinutes = sessions
    .filter((session) => session.requestId === request.id && session.status === '已完成')
    .reduce((sum, session) => sum + durationMinutes(session.startTime, session.endTime), 0);
  let remaining = Math.max(0, request.exposureMinutes - completedMinutes);

  const eligibleNights = nights
    .filter((night) => night.date <= request.deadline)
    .sort((a, b) => a.date.localeCompare(b.date));
  const availableTelescopes = telescopes.filter((telescope) => telescope.status === '可用');

  for (const night of eligibleNights) {
    if (remaining <= 0) break;
    for (const telescope of availableTelescopes) {
      if (remaining <= 0) break;
      // 同一夜同一望远镜可能要排多块，逐块找空档
      for (;;) {
        if (remaining <= 0) break;
        const intervals = occupiedIntervals(night.id, telescope.id, [...sessions, ...result]);
        const chunk = Math.min(CHUNK_MINUTES, remaining);
        const gap = findGap(intervals, chunk);
        if (gap === null) break; // 该望远镜该夜没空档，换下一台 / 下一夜
        const startMin = gap;
        const endMin = gap + chunk;
        const instrument = instruments.find((item) => item.telescopeCode === telescope.code);
        const plannedFrames = target
          ? Math.max(1, Math.round((chunk * 60) / target.exposureSec))
          : Math.round(chunk * 2);
        const session: ObsSession = {
          id: uid('s'),
          nightId: night.id,
          targetId: request.targetId,
          startTime: minutesToTime(startMin),
          endTime: minutesToTime(endMin),
          telescopeId: telescope.id,
          instrumentId: instrument?.id ?? '',
          filterSlot: target?.filter ?? 'L',
          plannedFrames,
          status: '待执行',
          requestId: request.id,
          schemaVersion: SCHEMA_VERSION,
        };
        result.push(session);
        usedNightIds.add(night.id);
        remaining -= chunk;
      }
    }
  }

  return {
    sessions: result,
    scheduledMinutes: request.exposureMinutes - completedMinutes - remaining,
    remainderMinutes: remaining,
    usedNightIds: [...usedNightIds],
  };
}
