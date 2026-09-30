'use strict';
// 预约发布调度器：服务启动时立即核查已逾期/待执行预约，之后按固定间隔轮询。
// 重启后未到时的预约继续等待，已逾期的立即在同一事务中重核对并处理。
// 所有核对与落版均在 better-sqlite3 事务（BEGIN IMMEDIATE）内完成，
// 与人工发布并发或重复触发时，由写锁 + 状态重查保证至多生成一个新版本。

const TICK_MS = parseInt(process.env.SCHEDULE_TICK_MS || '1000', 10);
const store = require('./store');

function startScheduler(db, { tickMs = TICK_MS } = {}) {
  let running = false;
  const tick = () => {
    if (running) return; // 单进程内重入保护
    running = true;
    try {
      const results = store.runDueSchedules(db);
      for (const r of results) {
        if (r.status === 'published') {
          console.log(`[scheduler] 预约 #${r.id} 到期，已发布 v${r.versionId}`);
        } else if (r.status === 'invalid') {
          console.log(`[scheduler] 预约 #${r.id} 已失效：${(r.reasons || []).join('；')}`);
        }
      }
    } catch (e) {
      // 单个预约失败不应影响其他预约与服务进程；保持 pending，下个周期重试
      console.error('[scheduler] 到期预约处理失败：', e.message);
    } finally {
      running = false;
    }
  };

  // 启动即核查：处理重启期间已逾期的预约
  tick();
  const timer = setInterval(tick, Math.max(200, tickMs));
  if (typeof timer.unref === 'function') timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}

module.exports = { startScheduler };
