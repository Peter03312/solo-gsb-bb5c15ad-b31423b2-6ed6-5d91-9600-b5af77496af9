'use strict';
// 端到端业务测试：临时 DB + 真实 HTTP 服务，验证权限、范围、冲突合版、发布不可变、异议重定位
process.env.DATA_DIR = '/tmp/hrc-test-data';
process.env.PORT = '3987';
process.env.HOST = '127.0.0.1';

const fs = require('fs');
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });

const assert = require('assert');
const BASE = `http://127.0.0.1:${process.env.PORT}`;
let passed = 0;
function ok(cond, msg) { assert(cond, msg); passed++; console.log('  ✓', msg); }

async function req(method, path, body, cookie) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') || '' };
}
async function expectFail(p, statusPart, msgPart, label) {
  const r = await p;
  assert(r.status === statusPart || (r.status >= 400 && statusPart === 400),
    `${label}: 期望失败状态 ${statusPart}，实际 ${r.status}`);
  assert(r.json.error && r.json.error.includes(msgPart),
    `${label}: 错误信息应包含“${msgPart}”，实际：${r.json.error}`);
  ok(true, `${label} -> ${r.status} ${r.json.error}`);
}

async function login(u, p) {
  const r = await req('POST', '/api/login', { username: u, password: p });
  assert.strictEqual(r.status, 200, `登录失败: ${JSON.stringify(r.json)}`);
  return r.setCookie.split(';')[0];
}

// 码点偏移版 indexOf
function cpIndexOf(text, needle) {
  const t = Array.from(text), n = Array.from(needle);
  outer: for (let i = 0; i + n.length <= t.length; i++) {
    for (let j = 0; j < n.length; j++) if (t[i + j] !== n[j]) continue outer;
    return i;
  }
  return -1;
}

async function main() {
  require('../src/server');
  await new Promise((r) => setTimeout(r, 400));

  console.log('\n[认证与权限]');
  const rec = await login('recorder', 'recorder123');
  const rev = await login('reviewer', 'reviewer123');
  const par = await login('participant', 'participant123');
  ok(rec && rev && par, '三类用户登录成功');
  await expectFail(req('GET', '/api/booth'), 401, '未登录', '未登录访问总览');
  await expectFail(req('POST', '/api/doc/import', { title: 'x', text: '1. a' }, rev), 403, '无权操作', '复核员尝试导入');
  await expectFail(req('POST', '/api/proposals', { seg: 1, start: 0, end: 1, replacement: 'x', basis: 'b' }, par), 403, '无权操作', '参与者尝试提议');

  console.log('\n[导入与非法范围]');
  const transcript = fs.readFileSync(require('path').join(__dirname, '..', 'sample-transcript.txt'), 'utf8');
  const imp = await req('POST', '/api/doc/import', { title: '测试听证会', text: transcript }, rec);
  assert.strictEqual(imp.status, 201);
  ok(imp.json.baseVersionId === 1, '导入形成 v1');
  await expectFail(req('POST', '/api/doc/import', { title: 'x', text: '1. a' }, rec), 409, '不能重复导入', '重复导入');

  let booth = (await req('GET', '/api/booth', null, rec)).json;
  ok(booth.segments.length === 5, '解析出 5 个带段号段落');
  const seg2 = booth.segments.find((s) => s.seg === 2).text;
  const iDate = cpIndexOf(seg2, '2024'); // “2024年3月1日”起点
  ok(iDate > 0, `定位到第2段日期偏移 ${iDate}`);

  await expectFail(req('POST', '/api/proposals', { seg: 2, start: -1, end: 3, replacement: 'x', basis: 'b' }, rec),
    400, '非法范围', '负偏移');
  await expectFail(req('POST', '/api/proposals', { seg: 2, start: 0, end: 99999, replacement: 'x', basis: 'b' }, rec),
    400, '非法范围', '超出段长');
  await expectFail(req('POST', '/api/proposals', { seg: 99, start: 0, end: 1, replacement: 'x', basis: 'b' }, rec),
    400, '不存在段', '不存在的段号');
  await expectFail(req('POST', '/api/proposals', { seg: 2, start: iDate, end: iDate + 9, replacement: 'x', basis: '' }, rec),
    400, '依据不能为空', '空依据');

  console.log('\n[提议/采纳/驳回/冲突]');
  // P1: 第2段 2024年3月1日(9字符) -> 2024年3月2日
  const p1 = await req('POST', '/api/proposals',
    { seg: 2, start: iDate, end: iDate + 9, replacement: '2024年3月2日', basis: '被申请人指出录音为3月2日' }, rec);
  assert.strictEqual(p1.status, 201);
  const id1 = p1.json.id;
  ok(id1 >= 1, `记录员提交提议 #${id1}，绑定基版 v1`);

  // P2 与 P1 交叠：提交时即冲突（P1 还没采纳，故应为 pending）
  const p2 = await req('POST', '/api/proposals',
    { seg: 2, start: iDate + 2, end: iDate + 5, replacement: '25年', basis: '另一说法' }, rec);
  assert.strictEqual(p2.status, 201);
  booth = (await req('GET', '/api/booth', null, rec)).json;
  const P2 = booth.proposals.find((x) => x.id === p2.json.id);
  ok(P2.status === 'pending', '与待复核提议交叠允许提交（待复核不占位）');

  // 记录员不能自己采纳
  await expectFail(req('POST', `/api/proposals/${id1}/adopt`, {}, rec), 403, '无权操作', '记录员尝试采纳');

  let ad = await req('POST', `/api/proposals/${id1}/adopt`, {}, rev);
  assert.strictEqual(ad.status, 200);
  ok(!ad.json.markedConflict, `采纳 #${id1} 进入暂存区`);

  // 再采纳交叠的 P2 → 标记冲突，状态改变且不覆盖
  ad = await req('POST', `/api/proposals/${p2.json.id}/adopt`, {}, rev);
  ok(ad.json.markedConflict && ad.json.reason.includes('交叠'), `交叠采纳 #${p2.json.id} 被标记冲突且写明原因`);
  booth = (await req('GET', '/api/booth', null, rev)).json;
  ok(booth.proposals.find((x) => x.id === p2.json.id).status === 'conflicted', '交叠提议状态为 conflicted');
  ok(booth.stage.length === 1, '暂存区仍只有不冲突的 1 项（未覆盖其他修订）');

  // 同段内互不重叠的 P3：第2段“申请人张三” -> “申请人张三丰”？构造一个不与 P1 交叠的范围
  const iName = cpIndexOf(seg2, '张三');
  const p3 = await req('POST', '/api/proposals',
    { seg: 2, start: iName, end: iName + 2, replacement: '张三丰', basis: '身份证姓名为张三丰' }, rec);
  assert.strictEqual(p3.status, 201);
  ad = await req('POST', `/api/proposals/${p3.json.id}/adopt`, {}, rev);
  ok(!ad.json.markedConflict, `互不重叠提议 #${p3.json.id} 可采纳`);

  // 重复采纳
  await expectFail(req('POST', `/api/proposals/${id1}/adopt`, {}, rev), 409, '重复采纳', '重复采纳');

  // 驳回一个已采纳的（从暂存区撤回）——这里驳回 P3
  const rj = await req('POST', `/api/proposals/${p3.json.id}/reject`, { reason: '证据不足' }, rev);
  ok(rj.status === 200, '复核员可驳回并把已采纳项移出暂存区');
  booth = (await req('GET', '/api/booth', null, rev)).json;
  ok(booth.stage.length === 1, '驳回后暂存区恢复为 1 项');

  console.log('\n[发布合并与不可变]');
  await expectFail(req('POST', '/api/publish', {}, par), 403, '无权操作', '参与者尝试发布');

  // 先发一个待复核的过期基版提议（段4的范围），发布后应变冲突
  const seg4 = (await req('GET', '/api/booth', null, rec)).json.segments.find((s) => s.seg === 4).text;
  const iW = cpIndexOf(seg4, '王五');
  const p4 = await req('POST', '/api/proposals',
    { seg: 4, start: iW, end: iW + 2, replacement: '王武', basis: '笔误' }, rec);
  assert.strictEqual(p4.status, 201);

  // 空发布防护：先把 P1 驳回，再发布应 409；然后恢复流程——改为直接发布（含P1）
  // 为保留空发布用例，另测：当前暂存区有 P1，直接发布成功；空发布用例会在之后验证。
  const pub = await req('POST', '/api/publish', { note: '第一次修订' }, rev);
  assert.strictEqual(pub.status, 201);
  ok(pub.json.versionId === 2, '发布形成不可变 v2');

  booth = (await req('GET', '/api/booth', null, rev)).json;
  const newSeg2 = booth.segments.find((s) => s.seg === 2).text;
  ok(newSeg2.includes('2024年3月2日') && !newSeg2.includes('2024年3月1日'),
    'v2 正文已合并替换（3月1日→3月2日）');
  const P1now = booth.proposals.find((x) => x.id === id1);
  ok(P1now.status === 'published' && P1now.published_version_id === 2, `#${id1} 状态为 published@v2`);
  const P4now = booth.proposals.find((x) => x.id === p4.json.id);
  ok(P4now.status === 'conflicted' && P4now.conflict_reason.includes('基版已过期'),
    `发布后基版过期的待决提议 #${p4.json.id} 自动标记冲突`);

  // 空发布（重复发布）必须报错且不改状态
  await expectFail(req('POST', '/api/publish', { note: '再发一次' }, rev), 409, '重复发布', '暂存区为空时发布');
  booth = (await req('GET', '/api/booth', null, rev)).json;
  ok(booth.currentVersion.id === 2, '失败发布未改变当前版本');

  // v1 不可变
  const v1 = (await req('GET', '/api/versions/1', null, par)).json;
  ok(v1.segments.find((s) => s.seg === 2).text.includes('2024年3月1日'), 'v1 正文快照保持原文不变');
  const v2 = (await req('GET', '/api/versions/2', null, par)).json;
  ok(v2.immutable === true, '版本视图标记 immutable');
  const decTypes = v2.decisions.map((d) => d.type);
  ok(decTypes.includes('adopt') && decTypes.includes('reject') &&
     decTypes.includes('conflict') && decTypes.includes('publish'),
    'v2 决议视图含采纳/驳回/冲突/发布留痕');

  console.log('\n[异议引用与重新定位]');
  // 异议锚定 v2 第2段中现在的文字“2024年3月2日”
  const v2seg2 = v2.segments.find((s) => s.seg === 2).text;
  const iNewDate = cpIndexOf(v2seg2, '2024年3月2日');
  const obj = await req('POST', '/api/objections',
    { seg: 2, start: iNewDate, end: iNewDate + 9, note: '日期仍需核对原始录音' }, par);
  assert.strictEqual(obj.status, 201);
  const oid = obj.json.id;
  ok(oid >= 1, `参与者提出异议 #${oid}`);
  await expectFail(req('POST', '/api/objections',
    { seg: 2, start: 0, end: 999, note: 'x' }, par), 400, '非法范围', '异议非法范围');

  // 记录员再提一个修订删除“2024年3月2日”，复核采纳发布 v3 -> 异议须 needs_relocation，快照保留
  const p5 = await req('POST', '/api/proposals',
    { seg: 2, start: iNewDate, end: iNewDate + 9, replacement: '3月上旬', basis: '录音仅可辨认到3月上旬' }, rec);
  assert.strictEqual(p5.status, 201);
  const ad5 = await req('POST', `/api/proposals/${p5.json.id}/adopt`, {}, rev);
  assert.strictEqual(ad5.status, 200);
  // 发布前闸门：p5 删除异议所引日期范围，触及异议 #oid，复核员须先回应
  const chkV3 = (await req('GET', '/api/review-checklist', null, rev)).json;
  ok(chkV3.items.some((x) => x.objectionId === oid && x.state === 'missing'
    && JSON.stringify(x.touchedProposalIds) === JSON.stringify([p5.json.id])),
    'v3 发布前：异议被 p5 触及，清单提示待回应并关联 p5');
  const rspV3 = await req('POST', `/api/objections/${oid}/respond`,
    { note: '录音复核仅能辨认到3月上旬，原日期异议随概括性修订留档，发布后另行重新定位。' }, rev);
  assert.strictEqual(rspV3.status, 201, 'v3 发布前完成异议回应');
  const pubV3 = await req('POST', '/api/publish', { note: '第二次修订' }, rev);
  assert.strictEqual(pubV3.status, 201);

  booth = (await req('GET', '/api/booth', null, par)).json;
  ok(booth.currentVersion.id === 3, '发布 v3');
  const o3 = booth.objections.find((x) => x.id === oid);
  ok(o3.anchor_status === 'needs_relocation', `相交修订发布后异议 #${oid} 标记待重新定位`);
  ok(o3.quoted_text === '2024年3月2日', `异议原文快照保留为“${o3.quoted_text}”，未悄悄指向新文字`);

  // v3 历史版本只读展示该回应
  const v3check = (await req('GET', '/api/versions/3', null, par)).json;
  ok(v3check.responses.length === 1 && v3check.responses[0].objectionId === oid
    && JSON.stringify(v3check.responses[0].touchedProposalIds) === JSON.stringify([p5.json.id]),
    'v3 历史版本只读固化发布前回应并保留关联提议');

  // v2 的异议视图仍为 active，历史不变
  const v2again = (await req('GET', '/api/versions/2', null, par)).json;
  const oa2 = v2again.objections.find((x) => x.id === oid);
  ok(oa2 && oa2.status === 'active' && oa2.quoted_text === '2024年3月2日', 'v2 历史异议锚点不被追溯修改');
  const v3 = (await req('GET', '/api/versions/3', null, par)).json;
  const oa3 = v3.objections.find((x) => x.id === oid);
  ok(oa3 && oa3.status === 'needs_relocation', 'v3 异议视图显示待重新定位');

  // 无权重新定位（其他参与者既非提出者也非复核员）—— 用 rec? rec 是 recordist 非作者
  const seg3 = booth.segments.find((s) => s.seg === 2).text;
  const i3 = cpIndexOf(seg3, '3月上旬');
  await expectFail(req('POST', `/api/objections/${oid}/relocate`,
    { seg: 2, start: i3, end: i3 + 4 }, rec), 403, '无权操作', '无关用户尝试重新定位');

  // 非法重定位范围
  await expectFail(req('POST', `/api/objections/${oid}/relocate`,
    { seg: 2, start: 0, end: 99999 }, par), 400, '非法范围', '重新定位非法范围');

  // 提出者重新定位成功
  const rl = await req('POST', `/api/objections/${oid}/relocate`,
    { seg: 2, start: i3, end: i3 + 4 }, par);
  ok(rl.status === 200, '提出者成功重新定位异议');
  booth = (await req('GET', '/api/booth', null, par)).json;
  const oDone = booth.objections.find((x) => x.id === oid);
  ok(oDone.anchor_status === 'active', '重新定位后异议恢复 active');

  // 对仍有效的异议重复重定位须报错
  await expectFail(req('POST', `/api/objections/${oid}/relocate`,
    { seg: 2, start: i3, end: i3 + 4 }, par), 409, '无需重新定位', '对有效异议重复重定位');

  console.log('\n[重定位后再发布不相交修订：锚点保持有效]');
  // 第1段的修订与已重定位到第2段的异议不相交，发布 v4 后异议仍应 active
  const curSeg1 = (await req('GET', '/api/booth', null, rec)).json.segments.find((s) => s.seg === 1).text;
  const iOpen = cpIndexOf(curSeg1, '现在开庭');
  const p6 = await req('POST', '/api/proposals',
    { seg: 1, start: iOpen, end: iOpen + 4, replacement: '现在宣布开庭', basis: '审判长原话' }, rec);
  assert.strictEqual(p6.status, 201);
  const ad6 = await req('POST', `/api/proposals/${p6.json.id}/adopt`, {}, rev);
  assert.strictEqual(ad6.status, 200);
  await req('POST', '/api/publish', { note: '第三次修订' }, rev);
  booth = (await req('GET', '/api/booth', null, par)).json;
  ok(booth.currentVersion.id === 4, '发布 v4');
  const oAfter = booth.objections.find((x) => x.id === oid);
  ok(oAfter.anchor_status === 'active', '不相交修订发布后，已重定位异议保持 active（不回退）');

  console.log('\n[续提：权限与前置校验]');
  // 当前 v4；p4（第4段 王五→王武，基版 v1）已因发布被标“基版已过期”
  const pid4 = p4.json.id;
  await expectFail(req('POST', `/api/proposals/${pid4}/rebase-preview`, {}, rev), 403, '无权操作', '复核员尝试续提预览');
  await expectFail(req('POST', `/api/proposals/${pid4}/rebase-preview`, {}, par), 403, '无权操作', '参与者尝试续提预览');
  await expectFail(req('POST', `/api/proposals/${p2.json.id}/rebase-preview`, {}, rec), 409, '基版已过期', '交叠类冲突提议续提');
  await expectFail(req('POST', `/api/proposals/${id1}/rebase-preview`, {}, rec), 409, '冲突', '已发布提议续提');
  await expectFail(req('POST', '/api/proposals/9999/rebase-preview', {}, rec), 404, '不存在', '续提不存在的提议');

  // 第二名记录员（非本人）——直接落库建号后登录
  const { hashPassword, DB_PATH } = require('../src/db');
  const Database = require('better-sqlite3');
  const raw = new Database(DB_PATH);
  raw.prepare(`INSERT INTO users (username, display_name, role, password_hash) VALUES (?,?,?,?)`)
    .run('recorder2', '记录员乙', 'recordist', hashPassword('recorder234'));
  raw.close();
  const rec2 = await login('recorder2', 'recorder234');
  await expectFail(req('POST', `/api/proposals/${pid4}/rebase-preview`, {}, rec2), 403, '本人', '非本人提议拒绝续提');

  console.log('\n[续提：预览换算与确认生成]');
  const pv1 = await req('POST', `/api/proposals/${pid4}/rebase-preview`, {}, rec);
  assert.strictEqual(pv1.status, 200);
  ok(pv1.json.fromVersion === 1 && pv1.json.toVersion === 4,
    `预览：v${pv1.json.fromVersion} → v${pv1.json.toVersion} 逐版换算`);
  ok(pv1.json.seg === 4 && pv1.json.excerpt === '王五', '目标选区摘录与原文一致（本段无中途修订，偏移不变）');
  ok(pv1.json.replacement === '王武' && pv1.json.basis === '笔误', '预览带回原替换文字与依据');
  ok(pv1.json.stageOverlap === null && pv1.json.token && pv1.json.token.v === 4, '暂存区无交叠，返回预览凭证');

  await expectFail(req('POST', `/api/proposals/${pid4}/rebase-confirm`, {}, rec), 400, '预览凭证', '缺少预览凭证拒绝确认');

  const cf1 = await req('POST', `/api/proposals/${pid4}/rebase-confirm`, { token: pv1.json.token }, rec);
  assert.strictEqual(cf1.status, 201);
  const nid1 = cf1.json.id;
  booth = (await req('GET', '/api/booth', null, rec)).json;
  const N1 = booth.proposals.find((x) => x.id === nid1);
  ok(N1 && N1.status === 'pending' && N1.base_ver === 4, `续提生成新待复核提议 #${nid1}（基版 v4）`);
  ok(N1.rebased_from_id === pid4 && N1.original_excerpt === '王五' && N1.replacement === '王武',
    '新提议关联原提议并沿用替换文字与依据');
  const P4after = booth.proposals.find((x) => x.id === pid4);
  ok(P4after.status === 'conflicted' && P4after.continued_by_id === nid1,
    '原冲突提议保持可追溯（状态不变，标注已续提）');

  // 新提议沿用现有复核与发布规则
  const adN1 = await req('POST', `/api/proposals/${nid1}/adopt`, {}, rev);
  ok(adN1.status === 200 && !adN1.json.markedConflict, '续提提议可被复核员正常采纳');
  const pub5 = await req('POST', '/api/publish', { note: '续提发布' }, rev);
  ok(pub5.status === 201 && pub5.json.versionId === 5, '续提提议随 v5 发布');
  booth = (await req('GET', '/api/booth', null, rec)).json;
  ok(booth.segments.find((s) => s.seg === 4).text.includes('王武'), 'v5 正文已应用续提修订');

  console.log('\n[续提：中途修订触及选区 → 拒绝]');
  let seg1now = booth.segments.find((s) => s.seg === 1).text; // 含“现在宣布开庭”
  const iOpen2 = cpIndexOf(seg1now, '现在宣布开庭');
  const p7 = await req('POST', '/api/proposals',
    { seg: 1, start: iOpen2, end: iOpen2 + 6, replacement: '现在正式开庭', basis: '庭长口径' }, rec);
  assert.strictEqual(p7.status, 201);
  // 另一提议覆盖同一范围并被采纳发布 → p7 基版过期且选区被中途修订触及
  const p8 = await req('POST', '/api/proposals',
    { seg: 1, start: iOpen2, end: iOpen2 + 6, replacement: '现在继续开庭', basis: '录音核对' }, rec);
  assert.strictEqual(p8.status, 201);
  await req('POST', `/api/proposals/${p8.json.id}/adopt`, {}, rev);
  await req('POST', '/api/publish', { note: '触及选区' }, rev);
  booth = (await req('GET', '/api/booth', null, rec)).json;
  ok(booth.currentVersion.id === 6, '发布 v6');
  ok(booth.proposals.find((x) => x.id === p7.json.id).status === 'conflicted', 'p7 因发布被标基版已过期');
  await expectFail(req('POST', `/api/proposals/${p7.json.id}/rebase-preview`, {}, rec), 409, '触及', '中途修订触及选区，预览即拒绝');

  console.log('\n[续提：零长度选区的插入点]');
  seg1now = booth.segments.find((s) => s.seg === 1).text; // 含“现在继续开庭”
  const iCont = cpIndexOf(seg1now, '现在继续开庭');
  // 插入点紧贴“现在继续开庭”之后
  const p9 = await req('POST', '/api/proposals',
    { seg: 1, start: iCont + 6, end: iCont + 6, replacement: '，全体起立', basis: '程序记录' }, rec);
  assert.strictEqual(p9.status, 201);
  // 修订替换“现在继续开庭”（其终点恰为插入点）→ 触及插入点
  const p10 = await req('POST', '/api/proposals',
    { seg: 1, start: iCont, end: iCont + 6, replacement: '庭审继续进行', basis: '录音核对' }, rec);
  assert.strictEqual(p10.status, 201);
  await req('POST', `/api/proposals/${p10.json.id}/adopt`, {}, rev);
  await req('POST', '/api/publish', { note: '触及插入点' }, rev);
  booth = (await req('GET', '/api/booth', null, rec)).json;
  ok(booth.currentVersion.id === 7, '发布 v7');
  await expectFail(req('POST', `/api/proposals/${p9.json.id}/rebase-preview`, {}, rec), 409, '插入点', '修订终点触及插入点，拒绝换算');

  // 未被触及的零长度选区：可预览、可确认
  const p11 = await req('POST', '/api/proposals',
    { seg: 5, start: 0, end: 0, replacement: '【核对】', basis: '补记标记' }, rec);
  assert.strictEqual(p11.status, 201);
  // 在第2段发布与第5段无关的修订，使 p11 基版过期
  const seg2v7 = booth.segments.find((s) => s.seg === 2).text;
  const iShang = cpIndexOf(seg2v7, '3月上旬');
  const p12 = await req('POST', '/api/proposals',
    { seg: 2, start: iShang, end: iShang + 4, replacement: '3月初', basis: '录音仅可辨认到月初' }, rec);
  assert.strictEqual(p12.status, 201);
  await req('POST', `/api/proposals/${p12.json.id}/adopt`, {}, rev);
  // 发布闸门：p12 的“3月上旬→3月初”触及已重定位到该范围的异议 #oid，须先回应
  if ((await req('GET', '/api/review-checklist', null, rev)).json.items
        .some((x) => x.objectionId === oid && x.state !== 'responded')) {
    const rspV8 = await req('POST', `/api/objections/${oid}/respond`,
      { note: '录音仅能辨认到“3月初”，同意概括口径，异议留档。' }, rev);
    assert.strictEqual(rspV8.status, 201, 'v8 发布前完成异议回应');
  }
  await req('POST', '/api/publish', { note: '无关修订' }, rev);
  booth = (await req('GET', '/api/booth', null, rec)).json;
  ok(booth.currentVersion.id === 8, '发布 v8（第5段未被改动）');
  const pv11 = await req('POST', `/api/proposals/${p11.json.id}/rebase-preview`, {}, rec);
  ok(pv11.status === 200 && pv11.json.start === 0 && pv11.json.end === 0 && pv11.json.excerpt === '',
    '零长度选区未被触及：预览成功（插入点不变）');
  const cf11 = await req('POST', `/api/proposals/${p11.json.id}/rebase-confirm`, { token: pv11.json.token }, rec);
  ok(cf11.status === 201, '零长度续提确认成功');

  console.log('\n[续提：暂存区交叠与预览后变化]');
  // p13：基版 v8，第2段范围覆盖“3月初”
  const seg2v8 = booth.segments.find((s) => s.seg === 2).text;
  const iChu = cpIndexOf(seg2v8, '3月初');
  const p13 = await req('POST', '/api/proposals',
    { seg: 2, start: iChu, end: iChu + 3, replacement: '3月上旬', basis: '再次核对录音' }, rec);
  assert.strictEqual(p13.status, 201);
  // p14：第2段前部“申请人张三称”→“申请人张某称”（等长替换，不改变后续偏移），采纳并发布 v9 → p13 过期
  const iName2 = cpIndexOf(seg2v8, '申请人张三称');
  const p14 = await req('POST', '/api/proposals',
    { seg: 2, start: iName2, end: iName2 + 6, replacement: '申请人张某称', basis: '匿名化处理' }, rec);
  assert.strictEqual(p14.status, 201);
  await req('POST', `/api/proposals/${p14.json.id}/adopt`, {}, rev);
  await req('POST', '/api/publish', { note: '匿名化' }, rev);
  booth = (await req('GET', '/api/booth', null, rec)).json;
  ok(booth.currentVersion.id === 9, '发布 v9（等长替换，后续偏移不变）');
  ok(booth.proposals.find((x) => x.id === p13.json.id).conflict_kind === 'base_expired', 'p13 标记为基版已过期');

  // 暂存区交叠：p15 与 p13 的换算目标交叠且被采纳
  const seg2v9 = booth.segments.find((s) => s.seg === 2).text;
  const iChu9 = cpIndexOf(seg2v9, '3月初');
  const p15 = await req('POST', '/api/proposals',
    { seg: 2, start: iChu9, end: iChu9 + 3, replacement: '3月中旬', basis: '第三种说法' }, rec);
  assert.strictEqual(p15.status, 201);
  await req('POST', `/api/proposals/${p15.json.id}/adopt`, {}, rev);
  const pv13a = await req('POST', `/api/proposals/${p13.json.id}/rebase-preview`, {}, rec);
  ok(pv13a.status === 200 && pv13a.json.stageOverlap && pv13a.json.stageOverlap.id === p15.json.id,
    '预览提示目标与暂存区已采纳提议交叠');
  await expectFail(req('POST', `/api/proposals/${p13.json.id}/rebase-confirm`, { token: pv13a.json.token }, rec),
    409, '交叠', '目标与暂存区交叠，确认被拒绝');

  // 预览后暂存区变化：驳回 p15 后旧凭证失效
  const pv13b = await req('POST', `/api/proposals/${p13.json.id}/rebase-preview`, {}, rec);
  await req('POST', `/api/proposals/${p15.json.id}/reject`, { reason: '证据不足' }, rev);
  await expectFail(req('POST', `/api/proposals/${p13.json.id}/rebase-confirm`, { token: pv13b.json.token }, rec),
    409, '暂存区', '预览后暂存区变化，旧凭证被拒绝');

  // 重新预览后确认成功
  const pv13c = await req('POST', `/api/proposals/${p13.json.id}/rebase-preview`, {}, rec);
  const cf13 = await req('POST', `/api/proposals/${p13.json.id}/rebase-confirm`, { token: pv13c.json.token }, rec);
  ok(cf13.status === 201, '重新预览后确认成功');
  booth = (await req('GET', '/api/booth', null, rec)).json;
  const N13 = booth.proposals.find((x) => x.id === cf13.json.id);
  ok(N13.status === 'pending' && N13.base_ver === 9 && N13.rebased_from_id === p13.json.id,
    '新提议关联原提议并绑定当前基版');

  // 预览后版本变化：采纳 N13 并发布 v10，再用旧凭证确认 → 拒绝
  await req('POST', `/api/proposals/${cf13.json.id}/adopt`, {}, rev);
  // 发布闸门：N13（3月初→3月上旬）可能触及已重定位异议 #oid，按清单补回应
  if ((await req('GET', '/api/review-checklist', null, rev)).json.items
        .some((x) => x.state === 'missing' || x.state === 'invalid')) {
    for (const it of (await req('GET', '/api/review-checklist', null, rev)).json.items) {
      if (it.state === 'missing' || it.state === 'invalid') {
        await req('POST', `/api/objections/${it.objectionId}/respond`,
          { note: `续提修订随 v10 发布前回应：已复核提议 ${it.touchedProposalIds.map((x) => '#' + x).join('、')}，异议留档。` }, rev);
      }
    }
  }
  await req('POST', '/api/publish', { note: '续提再发布' }, rev);
  booth = (await req('GET', '/api/booth', null, rec)).json;
  ok(booth.currentVersion.id === 10, '发布 v10');
  await expectFail(req('POST', `/api/proposals/${p13.json.id}/rebase-confirm`, { token: pv13c.json.token }, rec),
    409, '重新预览', '预览后版本变化，旧凭证被拒绝');

  // 决议留痕：续提决议产生于 v9 发布之后，按水位线语义应出现在 v10 的决议视图中
  const v10view = (await req('GET', '/api/versions/10', null, par)).json;
  ok(v10view.decisions.some((d) => d.type === 'rebase' && d.proposal_id === cf13.json.id),
    '版本决议视图含续提留痕，可追溯');

  console.log('\n[发布前异议回应闸门：待回应 / 权限 / 空说明]');
  // 新异议锚定当前 v10 第5段 [0,2)
  booth = (await req('GET', '/api/booth', null, par)).json;
  const seg5v10 = booth.segments.find((s) => s.seg === 5).text;
  const og = await req('POST', '/api/objections',
    { seg: 5, start: 0, end: Math.min(2, Array.from(seg5v10).length), note: '闸门测试异议' }, par);
  assert.strictEqual(og.status, 201, '闸门测试异议已创建');
  const ogid = og.json.id;
  const ogLen = Math.min(2, Array.from(seg5v10).length);

  const gEmpty = (await req('GET', '/api/review-checklist', null, rev)).json;
  ok(gEmpty.stageCount === 0 && gEmpty.items.length === 0, '暂存区为空：复核清单无待回应项');

  // 采纳一条与异议锚点相交的修订（非零长度）
  const gpa = await req('POST', '/api/proposals',
    { seg: 5, start: 0, end: ogLen, replacement: '【核】', basis: '闸门-相交修订' }, rec);
  assert.strictEqual(gpa.status, 201);
  const gpaid = gpa.json.id;
  await req('POST', `/api/proposals/${gpaid}/adopt`, {}, rev);
  booth = (await req('GET', '/api/booth', null, rev)).json;
  let gi = booth.reviewChecklist.items.find((x) => x.objectionId === ogid);
  ok(booth.reviewChecklist.counts.missing === 1 && gi.state === 'missing'
    && JSON.stringify(gi.touchedProposalIds) === JSON.stringify([gpaid])
    && gi.anchor.seg === 5 && gi.anchor.start === 0 && gi.anchor.end === ogLen,
    '采纳相交修订后异议进入待回应集合，关联采纳提议与当前锚点');

  await expectFail(req('POST', `/api/objections/${ogid}/respond`, { note: '我也说两句' }, par),
    403, '无权操作', '参与者尝试回应');
  await expectFail(req('POST', `/api/objections/${ogid}/respond`, { note: '我也说两句' }, rec),
    403, '无权操作', '记录员尝试回应');
  await expectFail(req('POST', `/api/objections/${ogid}/respond`, { note: '   ' }, rev),
    400, '回应说明不能为空', '空回应说明被拒绝');

  // 未回应发布 → 409 结构化清单，状态不变
  let blocked = await req('POST', '/api/publish', { note: '拦截' }, rev);
  ok(blocked.status === 409 && blocked.json.code === 'PENDING_OBJECTION_RESPONSES'
    && blocked.json.details.blocking.some((b) => b.objectionId === ogid && b.state === 'missing'),
    '缺失回应：发布被拒绝并返回结构化待回应项');
  booth = (await req('GET', '/api/booth', null, rev)).json;
  ok(booth.currentVersion.id === 10 && booth.stage.length === 1, '拒绝发布后版本与暂存区不变');

  // 对未被触及的异议回应 → 409
  const ofar2 = await req('POST', '/api/objections',
    { seg: 3, start: 0, end: 1, note: '完全无关的异议' }, par);
  assert.strictEqual(ofar2.status, 201);
  await expectFail(req('POST', `/api/objections/${ofar2.json.id}/respond`, { note: '说明' }, rev),
    409, '未被暂存区中的采纳修订触及', '回应未被触及异议被拒绝');

  console.log('\n[发布前异议回应闸门：回应后发布、历史版本固化]');
  const rsp = await req('POST', `/api/objections/${ogid}/respond`,
    { note: '已核对：该段开头按记录规范加【核】标记，异议所述问题纳入留档。' }, rev);
  ok(rsp.status === 201 && rsp.json.responseId >= 1, '复核员回应成功');
  booth = (await req('GET', '/api/booth', null, rev)).json;
  gi = booth.reviewChecklist.items.find((x) => x.objectionId === ogid);
  ok(gi.state === 'responded' && gi.response.boundProposalIds.length === 1
    && gi.response.boundProposalIds[0] === gpaid, '清单显示已回应及绑定提议');
  ok((await req('GET', '/api/versions/10', null, par)).json.responses
      .every((r) => r.objectionId !== ogid),
    '当前新草稿不出现在既有历史版本');

  const pubG = await req('POST', '/api/publish', { note: '闸门：回应后发布' }, rev);
  ok(pubG.status === 201 && pubG.json.versionId === 11, '逐条回应后发布 v11 成功');
  const v11 = (await req('GET', '/api/versions/11', null, par)).json;
  const rv11 = v11.responses.find((r) => r.objectionId === ogid);
  ok(rv11 && rv11.note.includes('已核对') &&
     JSON.stringify(rv11.touchedProposalIds) === JSON.stringify([gpaid]) &&
     rv11.anchorSeg === 5 && rv11.anchorStart === 0 && rv11.anchorEnd === ogLen,
    'v11 只读展示回应：关联提议、回应时版本锚点均固化');
  const og11 = v11.objections.find((x) => x.id === ogid);
  ok(og11 && Array.from(og11.quoted_text).length === ogLen,
    '历史版本保留异议原文快照');
  ok(v11.decisions.some((d) => d.type === 'objection_respond' &&
     d.reason.includes(`#${ogid}`) && d.version_id === 11),
    '决议流包含异议回应留痕');
  await expectFail(req('DELETE', `/api/objections/${ogid}/response`, null, rev),
    409, '没有可撤回的回应草稿', '已发布回应不可撤回（只读）');

  console.log('\n[发布前异议回应闸门：驳回关联提议→草稿不适用→撤回]');
  // 第3段的 ofar2 异议 [0,1)：采纳触及它的修订并回应，再驳回 → orphan
  const h1 = await req('POST', '/api/proposals',
    { seg: 3, start: 0, end: 1, replacement: '被', basis: '第3段首字' }, rec);
  assert.strictEqual(h1.status, 201);
  await req('POST', `/api/proposals/${h1.json.id}/adopt`, {}, rev);
  let chk = (await req('GET', '/api/review-checklist', null, rev)).json;
  ok(chk.items.some((x) => x.objectionId === ofar2.json.id && x.state === 'missing'),
    '第3段异议被采纳修订触及，待回应');
  await req('POST', `/api/objections/${ofar2.json.id}/respond`, { note: '第3段回应：同意首字订正。' }, rev);
  await req('POST', `/api/proposals/${h1.json.id}/reject`, { reason: '再议' }, rev);
  chk = (await req('GET', '/api/review-checklist', null, rev)).json;
  const orphanItem = chk.items.find((x) => x.objectionId === ofar2.json.id);
  ok(orphanItem.state === 'orphan'
    && orphanItem.invalidReasons[0].includes('不被当前暂存修订触及')
    && chk.counts.missing === 0 && chk.counts.invalid === 0,
    '驳回唯一关联提议后回应草稿不适用且不阻塞（无受影响异议）');
  const wd2 = await req('DELETE', `/api/objections/${ofar2.json.id}/response`, null, rev);
  ok(wd2.status === 200, '可撤回不适用草稿');
  await expectFail(req('POST', '/api/publish', { note: '空' }, rev), 409, '重复发布', '无暂存修订仍按原规则拒绝空发布');

  console.log('\n[发布前异议回应闸门：新增触及提议→绑定集合变化→回应失效]');
  // 在第3段布置两个都与异议 [0,1) 相交、彼此不重叠是不可能的（异议仅1码点）；
  // 改用第5段 ogid：v11 后该段开头是【核】……重建异议范围 [0,4) 以容纳两个相邻修订。
  booth = (await req('GET', '/api/booth', null, par)).json;
  const seg5v11 = booth.segments.find((s) => s.seg === 5).text;
  const og2 = await req('POST', '/api/objections',
    { seg: 5, start: 0, end: Math.min(4, Array.from(seg5v11).length), note: '集合变化异议' }, par);
  assert.strictEqual(og2.status, 201);
  const og2id = og2.json.id;
  const og2len = Math.min(4, Array.from(seg5v11).length);
  const k1 = await req('POST', '/api/proposals',
    { seg: 5, start: 0, end: Math.min(2, og2len), replacement: '甲乙', basis: '集合变化-1' }, rec);
  assert.strictEqual(k1.status, 201);
  await req('POST', `/api/proposals/${k1.json.id}/adopt`, {}, rev);
  await req('POST', `/api/objections/${og2id}/respond`, { note: '仅关联 k1 的回应。' }, rev);
  let k2 = null;
  if (og2len >= 3) {
    // 第二条与第一条半开相接且仍落在引用范围内（需要引用至少3码点：[0,2) 与 [2,3)）
    k2 = await req('POST', '/api/proposals',
      { seg: 5, start: 2, end: Math.min(3, og2len), replacement: '丙', basis: '集合变化-2' }, rec);
    assert.strictEqual(k2.status, 201);
    const adk2 = await req('POST', `/api/proposals/${k2.json.id}/adopt`, {}, rev);
    ok(!adk2.json.markedConflict, '相邻不重叠修订 k2 进入暂存区');
    chk = (await req('GET', '/api/review-checklist', null, rev)).json;
    const invItem = chk.items.find((x) => x.objectionId === og2id);
    ok(invItem.state === 'invalid'
      && invItem.invalidReasons.some((r) => r.includes('采纳提议集合已变化')),
      '新增触及异议的采纳提议：旧回应失效并给出原因');
    blocked = await req('POST', '/api/publish', { note: '拦截2' }, rev);
    ok(blocked.status === 409
      && blocked.json.details.blocking.some((b) => b.objectionId === og2id && b.state === 'invalid'),
      '存在失效回应时拒绝发布（版本、提议及决议均不改变）');
    await req('POST', `/api/objections/${og2id}/respond`, { note: '重新回应：k1、k2 均已复核。' }, rev);
    chk = (await req('GET', '/api/review-checklist', null, rev)).json;
    ok(chk.items.find((x) => x.objectionId === og2id).state === 'responded', '重新回应后恢复可发布状态');
  }

  console.log('\n[发布前异议回应闸门：插入点触及（端点口径）与重定位改锚]');
  // 清场：驳回上一段留在暂存区的 k1/k2，并撤回可能残留的回应草稿，保证本段干净
  for (const pid of [k1.json.id, k2 ? k2.json.id : null]) {
    if (pid == null) continue;
    await req('POST', `/api/proposals/${pid}/reject`, { reason: '场景清场' }, rev);
  }
  // 第3段 ofar2 异议当前锚点 [0,1) 且 active。先用一个相交修订发布，使异议进入“待重新定位”，
  // 同时发布前须回应（覆盖“非空修订相交”路径）。
  const z0 = await req('POST', '/api/proposals',
    { seg: 3, start: 0, end: 1, replacement: '本', basis: '第3段首字订正' }, rec);
  assert.strictEqual(z0.status, 201);
  await req('POST', `/api/proposals/${z0.json.id}/adopt`, {}, rev);
  chk = (await req('GET', '/api/review-checklist', null, rev)).json;
  ok(chk.items.some((x) => x.objectionId === ofar2.json.id && x.state === 'missing'),
    '相交修订触及异议：待回应');
  await req('POST', `/api/objections/${ofar2.json.id}/respond`, { note: '首字订正回应，发布后重新定位异议。' }, rev);
  const pubZ0 = await req('POST', '/api/publish', { note: '使异议进入待重定位' }, rev);
  assert.strictEqual(pubZ0.status, 201);
  booth = (await req('GET', '/api/booth', null, par)).json;
  const ofar2Cur = booth.objections.find((x) => x.id === ofar2.json.id);
  ok(ofar2Cur.anchor_status === 'needs_relocation', '相交发布后异议待重新定位');

  // 异议当前锚点起点附近的零长度修订插入点 k=a.end（引用终点）→ 触及
  const ptEnd = ofar2Cur.end_cp;
  const z1 = await req('POST', '/api/proposals',
    { seg: ofar2Cur.seg, start: ptEnd, end: ptEnd, replacement: '插', basis: '插入点终点' }, rec);
  assert.strictEqual(z1.status, 201);
  await req('POST', `/api/proposals/${z1.json.id}/adopt`, {}, rev);
  chk = (await req('GET', '/api/review-checklist', null, rev)).json;
  ok(chk.items.some((x) => x.objectionId === ofar2.json.id && x.state === 'missing'
    && JSON.stringify(x.touchedProposalIds) === JSON.stringify([z1.json.id])),
    '插入点恰在引用终点：算触及并关联该零长度修订');
  await req('POST', `/api/objections/${ofar2.json.id}/respond`, { note: '插入点在引用端点，已知悉。' }, rev);
  // 提出者把异议重定位到第4段（与第3段修订无关）→ 回应草稿变 orphan
  const seg4now = (await req('GET', '/api/booth', null, par)).json.segments.find((s) => s.seg === 4).text;
  const rlG = await req('POST', `/api/objections/${ofar2.json.id}/relocate`,
    { seg: 4, start: 0, end: Math.min(2, Array.from(seg4now).length) }, par);
  assert.strictEqual(rlG.status, 200, '提出者重定位异议到第4段');
  chk = (await req('GET', '/api/review-checklist', null, rev)).json;
  const movedItem = chk.items.find((x) => x.objectionId === ofar2.json.id);
  ok(movedItem && movedItem.state === 'orphan'
    && movedItem.invalidReasons.some((r) => r.includes('锚点') || r.includes('不被当前暂存修订触及')),
    '异议重定位改变当前锚点：原回应草稿不再适用（失效原因可见）');
  await req('DELETE', `/api/objections/${ofar2.json.id}/response`, null, rev);
  // 重定位后第3段插入点修订不再触及该异议 → 无受影响异议，可直接发布
  const pubZ = await req('POST', '/api/publish', { note: '插入点修订发布（无受影响异议）' }, rev);
  ok(pubZ.status === 201, '没有受影响异议时仍可按原规则发布');

  console.log(`\n全部通过：${passed} 项断言 ✅`);
  process.exit(0);
}

main().catch((e) => {
  console.error('\n测试失败：', e.message);
  console.error(e.stack);
  process.exit(1);
});
