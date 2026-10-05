import { useMemo, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import StatusChip from '../components/common/StatusChip';
import FieldRow from '../components/common/FieldRow';
import { usePersistentStore } from '../hooks/usePersistentStore';
import { useApplicationStore } from '../stores/applicationStore';
import { useNightStore } from '../stores/nightStore';
import { useReconcileStore } from '../stores/reconcileStore';
import { useSessionStore } from '../stores/sessionStore';
import { useTargetStore } from '../stores/targetStore';
import { RECONCILE_KIND_COLORS, type ReconcileIssue } from '../types';
import { buildReconcileIssues, unclaimedSessions } from '../utils/reconcile';
import { durationMinutes, formatMinutes } from '../utils/astro';

/** 对账台：两边按申请编号对账，对不上的先挂起等人定；迁移挂不上的段单列待认领 */
export default function ReconcilePage() {
  usePersistentStore();
  const applications = useApplicationStore((s) => s.applications);
  const sessions = useSessionStore((s) => s.sessions);
  const nights = useNightStore((s) => s.nights);
  const targets = useTargetStore((s) => s.targets);
  const rescheduleForApplication = useSessionStore((s) => s.rescheduleForApplication);
  const claimSession = useSessionStore((s) => s.claimSession);
  const removeSession = useSessionStore((s) => s.removeSession);
  const holds = useReconcileStore((s) => s.holds);
  const holdIssue = useReconcileStore((s) => s.holdIssue);
  const releaseHold = useReconcileStore((s) => s.releaseHold);

  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [holdTarget, setHoldTarget] = useState<ReconcileIssue | null>(null);
  const [holdNote, setHoldNote] = useState('');
  const [claimSessionId, setClaimSessionId] = useState('');
  const [claimCode, setClaimCode] = useState('');

  const issues = useMemo(() => buildReconcileIssues(applications, sessions, nights), [applications, sessions, nights]);
  const unclaimed = useMemo(() => unclaimedSessions(sessions), [sessions, nights]);
  const heldKeys = useMemo(() => new Set(holds.map((hold) => hold.issueKey)), [holds]);
  const openIssues = useMemo(() => issues.filter((issue) => !heldKeys.has(issue.key)), [issues, heldKeys]);

  const targetById = (id: string) => targets.find((target) => target.id === id);
  const nightById = (id: string) => nights.find((night) => night.id === id);
  const sessionById = (id: string) => sessions.find((session) => session.id === id);

  /** 漏排单 / 时长不符：按申请单现有时长触发编排台重排（编排台写坏只退本侧） */
  async function replan(code: string) {
    const app = applications.find((item) => item.code === code);
    if (!app) return;
    setError('');
    try {
      const result = await rescheduleForApplication(app);
      const queuedText = result.queued.length > 0 ? `；容量不足排队顺延（${result.queued.map((item) => item.code).join('、')}）` : '';
      setNotice(`已按申请单 ${code} 重排：失效 ${result.invalidated} 段、新排 ${result.created} 段${queuedText}`);
    } catch {
      setError(`编排台重排写入失败，编排台侧已回滚，申请台台账未受影响；可稍后重试`);
    }
  }

  async function submitHold() {
    if (!holdTarget) return;
    await holdIssue(holdTarget, holdNote);
    setNotice(`已挂起 ${holdTarget.kind}（${holdTarget.applicationCode}），等值班人裁定`);
    setHoldTarget(null);
    setHoldNote('');
  }

  async function submitClaim() {
    if (!claimSessionId || !claimCode) return;
    await claimSession(claimSessionId, claimCode);
    setNotice(`已把排程段 ${claimSessionId} 挂到申请单 ${claimCode}`);
    setClaimSessionId('');
    setClaimCode('');
  }

  function openClaim(sessionId: string, currentCode?: string) {
    setClaimSessionId(sessionId);
    setClaimCode(currentCode && applications.some((app) => app.code === currentCode) ? currentCode : (applications[0]?.code ?? ''));
  }

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 0.5 }}>
        对账与挂起
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        申请台与编排台按申请编号对账：孤儿段、漏排单、时长不符三类差异先挂起等值班人裁定；历史迁移挂不上编号的段单列待认领。
      </Typography>

      {notice ? (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>
          {notice}
        </Alert>
      ) : null}
      {error ? (
        <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError('')}>
          {error}
        </Alert>
      ) : null}

      <Stack direction="row" spacing={1} sx={{ mb: 2, flexWrap: 'wrap' }}>
        <Chip size="small" color={openIssues.length ? 'error' : 'success'} variant={openIssues.length ? 'filled' : 'outlined'} label={`待处理差异 ${openIssues.length}`} />
        <Chip size="small" color={unclaimed.length ? 'warning' : 'success'} variant={unclaimed.length ? 'filled' : 'outlined'} label={`待认领段 ${unclaimed.length}`} />
        <Chip size="small" variant="outlined" label={`挂起中 ${holds.length}`} />
      </Stack>

      <Typography variant="subtitle1" sx={{ mb: 1 }}>
        对账差异（{openIssues.length}）
      </Typography>
      <TableContainer component={Paper} variant="outlined" sx={{ mb: 3 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>类型</TableCell>
              <TableCell>申请编号</TableCell>
              <TableCell>差异说明</TableCell>
              <TableCell align="right">裁定操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {openIssues.map((issue) => (
              <TableRow key={issue.key} hover>
                <TableCell>
                  <Chip size="small" color={RECONCILE_KIND_COLORS[issue.kind]} label={issue.kind} />
                </TableCell>
                <TableCell>
                  <Typography variant="body2" sx={{ fontFamily: 'Menlo, Consolas, monospace' }}>
                    {issue.applicationCode || '-'}
                  </Typography>
                </TableCell>
                <TableCell>{issue.detail}</TableCell>
                <TableCell align="right">
                  {issue.kind === '孤儿段' && issue.sessionId ? (
                    <>
                      <Button size="small" onClick={() => openClaim(issue.sessionId!, issue.applicationCode)}>
                        改挂编号
                      </Button>
                      <Button size="small" color="warning" onClick={() => void claimSession(issue.sessionId!, '').then(() => setNotice(`排程段 ${issue.sessionId} 已解除关联，转待认领`))}>
                        转待认领
                      </Button>
                      <Button size="small" color="error" onClick={() => void removeSession(issue.sessionId!).then(() => setNotice(`已删除孤儿段 ${issue.sessionId}`))}>
                        删除段
                      </Button>
                    </>
                  ) : null}
                  {issue.kind === '漏排单' || issue.kind === '时长不符' ? (
                    <Button size="small" onClick={() => void replan(issue.applicationCode)}>
                      按单重排
                    </Button>
                  ) : null}
                  <Button
                    size="small"
                    color="inherit"
                    onClick={() => {
                      setHoldTarget(issue);
                      setHoldNote('');
                    }}
                  >
                    挂起
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {openIssues.length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} align="center">
                  <Typography variant="body2" color="text.secondary" sx={{ py: 3 }}>
                    两边台账按申请编号对账一致，没有待处理差异
                  </Typography>
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </TableContainer>

      <Typography variant="subtitle1" sx={{ mb: 1 }}>
        待认领（{unclaimed.length}）
      </Typography>
      <TableContainer component={Paper} variant="outlined" sx={{ mb: 3 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>排程段</TableCell>
              <TableCell>观测夜</TableCell>
              <TableCell>时段</TableCell>
              <TableCell>目标</TableCell>
              <TableCell>状态</TableCell>
              <TableCell align="right">操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {unclaimed.map((session) => (
              <TableRow key={session.id} hover>
                <TableCell>{session.id}</TableCell>
                <TableCell>{nightById(session.nightId)?.date ?? session.nightId}</TableCell>
                <TableCell>
                  {session.startTime}-{session.endTime}
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {formatMinutes(durationMinutes(session.startTime, session.endTime))}
                  </Typography>
                </TableCell>
                <TableCell>{targetById(session.targetId)?.name ?? '未知目标'}</TableCell>
                <TableCell>
                  <StatusChip status={session.status} />
                </TableCell>
                <TableCell align="right">
                  <Button size="small" onClick={() => openClaim(session.id)}>
                    认领挂编号
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {unclaimed.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} align="center">
                  <Typography variant="body2" color="text.secondary" sx={{ py: 3 }}>
                    没有待认领的排程段
                  </Typography>
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </TableContainer>

      <Typography variant="subtitle1" sx={{ mb: 1 }}>
        挂起中（{holds.length}）
      </Typography>
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>类型</TableCell>
              <TableCell>申请编号</TableCell>
              <TableCell>差异现场</TableCell>
              <TableCell>挂起备注</TableCell>
              <TableCell>挂起时间</TableCell>
              <TableCell align="right">操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {holds.map((hold) => (
              <TableRow key={hold.id} hover>
                <TableCell>
                  <Chip size="small" variant="outlined" color={RECONCILE_KIND_COLORS[hold.kind]} label={hold.kind} />
                </TableCell>
                <TableCell>
                  <Typography variant="body2" sx={{ fontFamily: 'Menlo, Consolas, monospace' }}>
                    {hold.applicationCode || '-'}
                  </Typography>
                </TableCell>
                <TableCell>
                  <Typography variant="caption">{hold.detail}</Typography>
                </TableCell>
                <TableCell>
                  <Typography variant="caption">{hold.note}</Typography>
                </TableCell>
                <TableCell>
                  <Typography variant="caption">{new Date(hold.createdAt).toLocaleString('zh-CN')}</Typography>
                </TableCell>
                <TableCell align="right">
                  <Button size="small" onClick={() => void releaseHold(hold.id).then(() => setNotice('已解除挂起，差异回到待处理列表'))}>
                    解除挂起
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {holds.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} align="center">
                  <Typography variant="body2" color="text.secondary" sx={{ py: 3 }}>
                    没有挂起中的差异
                  </Typography>
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog open={Boolean(holdTarget)} onClose={() => setHoldTarget(null)} maxWidth="sm" fullWidth>
        <DialogTitle>挂起差异，等值班人裁定</DialogTitle>
        <DialogContent>
          <Alert severity="info" sx={{ mb: 1.5 }}>
            {holdTarget?.detail}
          </Alert>
          <FieldRow label="挂起备注" hint="记录谁、为什么挂起，裁定后回到本页解除">
            <TextField size="small" fullWidth multiline minRows={2} value={holdNote} onChange={(event) => setHoldNote(event.target.value)} />
          </FieldRow>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setHoldTarget(null)}>取消</Button>
          <Button variant="contained" color="warning" onClick={() => void submitHold()}>
            确认挂起
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(claimSessionId)} onClose={() => setClaimSessionId('')} maxWidth="sm" fullWidth>
        <DialogTitle>认领 / 改挂申请编号</DialogTitle>
        <DialogContent>
          {claimSessionId ? (
            <Alert severity="info" sx={{ mb: 1.5 }}>
              排程段 {claimSessionId}（{sessionById(claimSessionId)?.startTime}-{sessionById(claimSessionId)?.endTime} ·{' '}
              {targetById(sessionById(claimSessionId)?.targetId ?? '')?.name ?? '未知目标'}）
            </Alert>
          ) : null}
          <FieldRow label="申请编号" required hint="把该段挂到申请台的某张单上，挂后参与对账">
            <TextField select size="small" fullWidth value={claimCode} onChange={(event) => setClaimCode(event.target.value)}>
              {applications.map((app) => (
                <MenuItem key={app.id} value={app.code}>
                  {`${app.code} · ${targetById(app.targetId)?.name ?? '-'} · 想拍 ${app.requestedMinutes} 分钟`}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setClaimSessionId('')}>取消</Button>
          <Button variant="contained" disabled={!claimCode} onClick={() => void submitClaim()}>
            确认挂接
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
