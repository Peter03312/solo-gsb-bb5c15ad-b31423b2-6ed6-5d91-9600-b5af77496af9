'use strict';
// 预约发布调度器：
//  - 启动时立即核查一次（重启后继续处理未到时预约，并立即执行已逾期预约）；
//  - 之后按固定间隔巡检：失效快照即时标记，到点预约在同一事务内核对并发布；
//  - 条件 UPDATE 领取 + better-sqlite3 同步事务，保证与人工发布并发或重复触发时至多生成一个新版本。

const DEFAULT_INTERVAL_MS = parseInt(process.env.SCHEDULE_TICK_MS || '500', 10);

function startScheduler(db, { intervalMs = DEFAULT_INTERVAL_MS, executeNow = true } = {}) {
  const tick = () => {
    try {
      const results = require('./store').executeDueSchedules(db);
      for (const r of results) {
        if (r.status === 'published') {
          console.log(`[scheduler] 预约 #${r.id} 到点执行成功，已发布 v${r.versionId}`);
        } else {
          console.log(`[scheduler] 预约 #${r.id} 到点核对失效：${(r.reasons || []).join('；')}`);
        }
      }
    } catch (e) {
      // 单次巡检异常不得影响后续巡检（事务已回滚，下次重试）
      console.error('[scheduler] 巡检失败：', e.message);
    }
  };
  if (executeNow) tick();
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref(); // 不阻止进程退出（测试）
  return {
    tick,
    stop: () => clearInterval(timer),
  };
}

module.exports = { startScheduler, DEFAULT_INTERVAL_MS };
