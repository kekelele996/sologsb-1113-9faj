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
import FieldRow from '../components/common/FieldRow';
import { usePersistentStore } from '../hooks/usePersistentStore';
import { useRequestStore } from '../stores/requestStore';
import { useSessionStore } from '../stores/sessionStore';
import { useTargetStore } from '../stores/targetStore';
import { useNightStore } from '../stores/nightStore';
import { reconcile, type ReconcileItem } from '../utils/reconcile';
import { durationMinutes, formatMinutes } from '../utils/astro';

const KIND_LABEL: Record<ReconcileItem['kind'], string> = {
  matched: '已对账',
  short: '排段中（容量不足）',
  unscheduled: '待排段',
  over: '对不上（排多了）',
};

const KIND_COLOR: Record<ReconcileItem['kind'], 'success' | 'primary' | 'default' | 'warning'> = {
  matched: 'success',
  short: 'primary',
  unscheduled: 'default',
  over: 'warning',
};

/** 对账台：两边按申请编号对账，对不上的先挂起等人定，挂不上的段单列待认领 */
export default function ReconcilePage() {
  usePersistentStore();
  const requests = useRequestStore((s) => s.requests);
  const suspendRequest = useRequestStore((s) => s.suspendRequest);
  const sessions = useSessionStore((s) => s.sessions);
  const updateSession = useSessionStore((s) => s.updateSession);
  const targets = useTargetStore((s) => s.targets);
  const nights = useNightStore((s) => s.nights);

  const [notice, setNotice] = useState('');
  const [claimOpen, setClaimOpen] = useState(false);
  const [claimSessionId, setClaimSessionId] = useState('');
  const [claimRequestId, setClaimRequestId] = useState('');

  const report = useMemo(() => reconcile(requests, sessions), [requests, sessions]);

  const targetById = (id: string) => targets.find((target) => target.id === id);
  const nightById = (id: string) => nights.find((night) => night.id === id);
  const requestById = (id: string) => requests.find((request) => request.id === id);

  const mismatchItems = report.items.filter((item) => item.kind === 'over');
  const activeItems = report.items.filter((item) => item.kind !== 'over');

  async function doSuspend(id: string) {
    await suspendRequest(id);
    setNotice('已挂起，等人定');
  }

  function openClaim(sessionId: string) {
    setClaimSessionId(sessionId);
    setClaimRequestId('');
    setClaimOpen(true);
  }

  async function submitClaim() {
    if (!claimRequestId) return;
    await updateSession(claimSessionId, { requestId: claimRequestId });
    setClaimOpen(false);
    setNotice(`已将排程段 ${claimSessionId} 认领给申请单 ${requestById(claimRequestId)?.code ?? claimRequestId}`);
  }

  return (
    <Box>
      <Typography variant="h5" sx={{ mb: 0.5 }}>
        对账台
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        两边按申请编号对账：申请单侧报曝光时长，编排单侧报已排分钟。对不上的先挂起等人定；旧数据没有编号的段单列待认领。
      </Typography>

      {notice ? (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setNotice('')}>
          {notice}
        </Alert>
      ) : null}

      <Stack direction="row" spacing={2} sx={{ mb: 2 }} flexWrap="wrap">
        <Chip size="small" color="success" label={`已对账 ${report.matchedCount}`} />
        <Chip size="small" color="warning" label={`对不上 ${report.mismatchCount}`} />
        <Chip size="small" label={`待认领 ${report.orphanCount}`} />
      </Stack>

      {mismatchItems.length > 0 ? (
        <Alert severity="warning" sx={{ mb: 2 }}>
          有 {mismatchItems.length} 张申请单对不上（编排侧已排分钟多于申请单时长），已挂起等人定。
        </Alert>
      ) : null}

      <Typography variant="h6" sx={{ mt: 1, mb: 1 }}>
        申请单对账
      </Typography>
      <TableContainer component={Paper} variant="outlined" sx={{ mb: 3 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>申请编号</TableCell>
              <TableCell>目标</TableCell>
              <TableCell align="right">申请时长</TableCell>
              <TableCell align="right">已排</TableCell>
              <TableCell align="right">已完成</TableCell>
              <TableCell>对账</TableCell>
              <TableCell>建议状态</TableCell>
              <TableCell align="right">操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {report.items.map((item) => (
              <TableRow key={item.request.id} hover>
                <TableCell>{item.request.code}</TableCell>
                <TableCell>{targetById(item.request.targetId)?.name ?? '未知目标'}</TableCell>
                <TableCell align="right">{item.request.exposureMinutes} 分</TableCell>
                <TableCell align="right">
                  {item.scheduledMinutes} 分
                  {item.invalidatedMinutes > 0 ? (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      失效 {item.invalidatedMinutes} 分
                    </Typography>
                  ) : null}
                </TableCell>
                <TableCell align="right">{item.completedMinutes} 分</TableCell>
                <TableCell>
                  <Chip size="small" label={KIND_LABEL[item.kind]} color={KIND_COLOR[item.kind]} variant={item.kind === 'matched' ? 'filled' : 'outlined'} />
                </TableCell>
                <TableCell>
                  <Typography variant="caption" color="text.secondary">
                    {item.suggestStatus}
                  </Typography>
                </TableCell>
                <TableCell align="right">
                  {item.kind === 'over' && item.request.status !== '已挂起' ? (
                    <Button size="small" color="warning" onClick={() => void doSuspend(item.request.id)}>
                      挂起
                    </Button>
                  ) : (
                    <Typography variant="caption" color="text.secondary">
                      -
                    </Typography>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      <Typography variant="h6" sx={{ mt: 2, mb: 1 }}>
        待认领排程段（{report.orphanSessions.length}）
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        旧数据的段没有申请编号，或段上的编号找不到对应申请单；按目标和时段核对后，认领给对应申请单。
      </Typography>
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>排程段 ID</TableCell>
              <TableCell>观测夜</TableCell>
              <TableCell>时段</TableCell>
              <TableCell>目标</TableCell>
              <TableCell>时长</TableCell>
              <TableCell>原因</TableCell>
              <TableCell align="right">操作</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {report.orphanSessions.map(({ session, reason }) => (
              <TableRow key={session.id} hover>
                <TableCell>{session.id}</TableCell>
                <TableCell>{nightById(session.nightId)?.date ?? session.nightId}</TableCell>
                <TableCell>
                  {session.startTime}-{session.endTime}
                </TableCell>
                <TableCell>{targetById(session.targetId)?.name ?? '未知目标'}</TableCell>
                <TableCell>{formatMinutes(durationMinutes(session.startTime, session.endTime))}</TableCell>
                <TableCell>
                  <Chip size="small" label={reason === 'no-request' ? '无编号' : '编号悬空'} color={reason === 'broken-link' ? 'warning' : 'default'} variant="outlined" />
                </TableCell>
                <TableCell align="right">
                  <Button size="small" onClick={() => openClaim(session.id)}>
                    认领
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {report.orphanSessions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} align="center">
                  <Typography variant="body2" color="text.secondary" sx={{ py: 3 }}>
                    没有待认领的排程段
                  </Typography>
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </TableContainer>

      <Dialog open={claimOpen} onClose={() => setClaimOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle>认领排程段</DialogTitle>
        <DialogContent>
          <Alert severity="info" sx={{ mb: 1.5 }}>
            将排程段 {claimSessionId} 认领给对应申请单，认领后按申请编号对账。
          </Alert>
          <FieldRow label="申请单" required>
            <TextField select size="small" fullWidth value={claimRequestId} onChange={(event) => setClaimRequestId(event.target.value)}>
              {requests.map((request) => (
                <MenuItem key={request.id} value={request.id}>
                  {`${request.code} · ${targetById(request.targetId)?.name ?? '未知目标'} · ${request.exposureMinutes} 分`}
                </MenuItem>
              ))}
            </TextField>
          </FieldRow>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setClaimOpen(false)}>取消</Button>
          <Button variant="contained" onClick={() => void submitClaim()}>
            确认认领
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
