# 听证会逐字稿网页校订台

供听证会**记录员**与**复核员**（及**参与者**）使用的网页校订台：导入带段号的 UTF-8 逐字稿后，
记录员可在段内选定字符范围提交“替换文字 + 依据”的修订提议；复核员可采纳、驳回提议并发布。
发布形成不可变版本；因发布而过期的提议可由记录员**续提**（按逐次发布的修订把原选区换算到当前正文后重提）；
参与者可对原文范围留下异议引用，修订使被引文字消失时保留原文快照并提示重新定位。

技术栈：Node.js（Express）+ SQLite（better-sqlite3）+ 无构建浏览器原生前端。

---

## 一、快速启动（Docker Compose 一键启动）

前置要求：已安装 Docker（含 Compose v2）。

```bash
# （可选）复制环境变量文件并按需修改端口、种子账户密码
cp .env.example .env

# 构建并后台启动
docker compose up -d --build

# 查看日志
docker compose logs -f
```

启动后浏览器访问：

> **http://localhost:3000**  （如修改了 `HOST_PORT`，则为 `http://localhost:<HOST_PORT>`）

停止与清理：

```bash
docker compose down          # 停止（保留数据卷 hearing-revision-data）
docker compose down -v       # 停止并删除数据卷（将清空全部数据）
```

SQLite 数据库保存在命名卷 `hearing-revision-data`（容器内 `/data/hearing.sqlite`）中。
如需用宿主机目录，可把 compose 中的卷改为 `./data:/data`。

### 演示账户（首次启动自动初始化）

| 角色 | 用户名 | 密码 | 可执行操作 |
| --- | --- | --- | --- |
| 记录员 | `recorder` | `recorder123` | 导入逐字稿、提交修订提议 |
| 复核员 | `reviewer` | `reviewer123` | 采纳/驳回提议、发布新版本、重新定位异议 |
| 参与者 | `participant` | `participant123` | 对原文范围提出异议、重新定位自己的异议 |

种子账户仅在数据库用户表为空时创建；可通过环境变量覆盖用户名与密码（见下文配置）。

---

## 二、本地直接运行（不用 Docker）

前置要求：Node.js ≥ 18（原生自带全局 `fetch`；开发环境为 Node 20）。better-sqlite3 为原生模块，
从 npm 安装时通常自动下载预编译二进制；若需源码编译，请准备 Python 3、make、g++。

```bash
npm install
npm start                 # 等价于 node src/server.js
```

然后访问 **http://localhost:3000**。

仅初始化数据库（建表 + 种子账户）不启动服务：

```bash
npm run init-db
```

运行测试（纯逻辑单元测试 + 启动临时服务的端到端测试）：

```bash
npm test
```

---

## 三、配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口（容器内）。宿主机端口用 compose 的 `HOST_PORT` 映射 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data`（本地）/ `/data`（容器） | SQLite 文件目录 |
| `DB_PATH` | `$DATA_DIR/hearing.sqlite` | 数据库文件完整路径 |
| `SESSION_TTL_MS` | `43200000` | 登录会话有效期（毫秒，默认 12 小时） |
| `SCHEDULE_TICK_MS` | `1000` | 预约发布轮询间隔（毫秒）；服务启动时总会立即核查一次已逾期预约 |
| `SEED_RECORDIST_USER` / `SEED_RECORDIST_PASS` | `recorder` / `recorder123` | 记录员种子账户 |
| `SEED_REVIEWER_USER` / `SEED_REVIEWER_PASS` | `reviewer` / `reviewer123` | 复核员种子账户 |
| `SEED_PARTICIPANT_USER` / `SEED_PARTICIPANT_PASS` | `participant` / `participant123` | 参与者种子账户 |

> 安全提示：演示使用 HTTP 与种子密码。生产部署请置于 HTTPS 反向代理之后，并修改全部种子密码；
> 种子账户仅在首次初始化（用户表为空）时生效。

---

## 四、使用流程

1. **记录员登录 → 导入逐字稿**
   - 粘贴 UTF-8 文本或选择 `.txt` 文件。行首段号支持 `12. 正文`、`12、正文`、`12 正文`；
     无段号的非空行自动顺延编号；段号重复会报错拒绝导入。
   - 导入即发布**不可变的第 1 版**。全场只允许导入一次，重复导入返回 409 且不改变状态。
2. **记录员在正文中拖选段内文字 → “提交修订提议”**，填写替换文字（空串表示删除，禁止换行跨段）与必填依据。
   - 提议**绑定提交时的已发布版本**（基版），并保存基版原文摘录快照。
3. **复核员**在右侧“提议”面板或正文标记上：
   - **采纳**：进入发布暂存区；**驳回**：可附原因，已采纳的也可驳回移出暂存区。
   - 采纳时若与暂存区已采纳修订**范围交叠**，或提议**基版已过期**，该提议被标记为“冲突”并写明原因，**不覆盖任何其他修订**。
4. **复核员发布**：同一基版上互不重叠的采纳结果按段合并，形成**不可变新版本**；
   暂存区为空时发布会被拒绝（防止重复发布）。发布后所有仍待复核的提议一律标记为“基版已过期”冲突，
   需由记录员基于新版本重新提交（可手工重提，也可用下述“续提”）。可随时切换“发布预览”查看合并效果。
5. **续提（基版已过期提议的换算重提）**：记录员可对**本人**因发布被标为“基版已过期”的冲突提议，
   在提议卡片或详情弹窗中点击“续提到当前版本…”发起**续提预览**；非本人或非此类冲突（如范围交叠）的提议会被拒绝。
   - 系统按从原基版到当前版**逐次发布的修订**，把原段内码点半开选区换算到当前正文，
     显示目标选区、当前摘录、原替换文字与依据（纯几何换算，**不凭同文搜索猜测位置**）。
   - 仅当该选区**未被中途修订触及**（零长度选区则其插入点未被任何修订区间触及），
     且换算目标**不与当前已采纳（暂存区）提议交叠**时，确认后生成**关联原提议的新待复核提议**
     （沿用原替换文字与依据，绑定当前版本为新基版）。
   - 中途修订触及选区/插入点、目标段缺失、或预览之后版本/暂存区发生变化时，确认被拒绝并提示
     **重新预览**或在当前正文**手工选区提交**；原冲突提议、决议与历史版本均保持可追溯，
     新提议沿用现有复核与发布规则。
6. **异议引用**：任何登录用户都可拖选原文范围提出异议，系统保存被引原文快照。
   - 之后发布的修订若与引用范围相交，引用不会自动改指新文字：该异议在新版本中显示
     **“待重新定位”**警示，原文快照继续保留；可由提出者或复核员在当前版本上手动重新定位并留痕。
7. **发布前异议回应（本轮新增）**：复核员**发布暂存修订前，须逐条回应被本次暂存修订触及的异议**。
   - “触及”按**段内 Unicode 码点半开区间**与异议**当前锚点**判断：暂存修订区间与引用 `[start,end)` 半开相交即触及
     （`[0,2)` 与 `[2,4)` 无缝相接互不触及）；**零长度修订的插入点落在引用范围内也算触及**（含引用两端点）。
   - 回应须填写**非空说明**，并自动关联：异议、当前触及它的**采纳提议集合**、回应时的**版本与暂存区快照**、异议当前锚点。
   - 采纳/驳回提议或异议被重新定位后，发布时会**重新核对受影响集合与回应绑定状态**：
     关联提议集合变化、锚点变化、版本变化 → 回应标记**“已失效”**并展示原因；新增被触及异议 → **“待回应”**；
     唯一关联提议被驳回使异议不再被触及 → 草稿标记**“不适用（orphan）”**（不阻塞，可撤回）。
   - 存在**缺失或失效回应时发布被拒绝**（`409 PENDING_OBJECTION_RESPONSES`，响应体携带结构化清单），
     **版本、提议及决议均不改变**；**没有受影响异议时仍可按原规则发布**。
   - 发布成功后回应随新版本固化，在**对应历史版本只读展示**；异议**原文快照**与既有**重定位规则**保持不变。
8. **版本查看**：“版本”面板可只读查看任一历史版本的**正文、决议（采纳/驳回/冲突/续提/异议回应/发布留痕）与异议**；
   历史版本内容不随后续发布改变。
9. **预约发布（本轮新增）**：复核员可把当前暂存修订**预约在含 UTC 偏移的未来时刻**自动发布，并填写**版本说明**。
   - 预约入口在正文下方发布条的“预约未来发布…”；预约时**按现有规则确认可发布**——暂存区非空、被触及异议均已有有效回应
     （缺失/失效回应、空暂存区、时间无效或非未来时间、已有待执行预约时一律拒绝并说明原因）。
   - 预约记录**当前版本、采纳提议的内容与集合、受影响异议及其有效回应的关联状态**；**同一时刻仅允许一个待执行预约**，
     复核员可在执行前取消。
   - 页面展示预约时间（UTC 绝对时刻与原始偏移写法）、创建人、状态（待执行/已发布/已失效/已取消）及**未发布原因**。
   - 到期在**同一事务**中重新核对预约快照与现有发布条件：**一致才生成一个不可变新版本并固化回应**；
     当前版本、暂存修订、受影响异议或回应关联任一已变化 → **标记预约失效**（写明原因），失效处理**不改动版本、提议和决议**，须重新预约。
   - **服务重启后继续处理未到时预约，并立即核查已逾期预约**；与人工发布并发或重复触发时，由数据库写锁与状态重查保证**至多生成一个新版本**。

所有失败场景（无权操作、非法字符范围、重复发布、重复导入、重复采纳/重定位等）均返回明确的
HTTP 状态码与中文原因，且在数据库事务中执行——失败即回滚，不改变任何状态。

### 字符范围口径

范围按 **Unicode 码点**计偏移、半开区间 `[start, end)`（前后端一致，emoji 等增补平面字符按 1 个字符计），
仅允许在同一段落内选择；`[0,2)` 与 `[2,4)` 视为不重叠，可无缝相接。

---

## 五、HTTP API 摘要

会话采用 HttpOnly Cookie（`POST /api/login` 返回 `session`）。除登录、静态资源外均需登录。

| 方法与路径 | 角色 | 说明 |
| --- | --- | --- |
| `POST /api/login` / `POST /api/logout` | 全部 | 登录 / 退出 |
| `GET /api/me` | 全部 | 当前用户 |
| `GET /api/booth` | 登录用户 | 当前版本正文、暂存区、提议、异议、版本列表 |
| `POST /api/doc/import` | 记录员 | 导入逐字稿（仅一次），形成 v1 |
| `POST /api/proposals` | 记录员 | 提交提议 `{seg,start,end,replacement,basis}` |
| `POST /api/proposals/:id/adopt` | 复核员 | 采纳；交叠/过期则返回冲突标记与原因 |
| `POST /api/proposals/:id/reject` | 复核员 | 驳回（可含 `reason`） |
| `POST /api/proposals/:id/rebase-preview` | 记录员（本人） | 续提预览：把“基版已过期”冲突提议的选区逐版换算到当前正文，返回目标选区/摘录/原替换文字与依据及确认凭证 |
| `POST /api/proposals/:id/rebase-confirm` | 记录员（本人） | 确认续提 `{token}`：校验凭证（版本与暂存区未变、选区未被触及、不与暂存区交叠）后生成关联原提议的新待复核提议 |
| `POST /api/publish` | 复核员 | 合并暂存修订并发布新版本；被触及异议存在缺失/失效回应时 409 拒绝（不改任何状态） |
| `GET /api/schedules` | 登录用户 | 预约发布列表：当前待执行预约 `pending` 与近期记录 `recent`（时间、创建人、状态、未发布原因） |
| `POST /api/schedules` | 复核员 | 创建预约 `{scheduledAt, note}`：`scheduledAt` 为含 UTC 偏移的未来时间（ISO 8601 或 epoch 毫秒），`note` 必填；预约时即按发布闸门确认可发布 |
| `DELETE /api/schedules/:id` | 复核员 | 执行前取消待执行预约 |
| `POST /api/objections` | 登录用户 | 对原文范围提出异议 `{seg,start,end,note}` |
| `POST /api/objections/:id/relocate` | 提出者或复核员 | 对“待重新定位”的异议手动重定位 |
| `GET /api/review-checklist` | 登录用户 | 当前版本发布前复核清单：被暂存修订触及的异议、关联提议、回应状态（missing/invalid/responded/orphan）与失效原因 |
| `POST /api/objections/:id/respond` | 复核员 | 对被暂存修订触及的异议填写/更新**非空**回应 `{note}`；未被触及返回 409 |
| `DELETE /api/objections/:id/response` | 复核员 | 撤回回应草稿（已随版本发布的回应只读，不可撤回） |
| `GET /api/versions/:id` | 登录用户 | 只读查看不可变版本（正文/决议/异议/**随该版固化的回应**） |

---

## 六、数据模型（SQLite）

- `versions`：不可变版本，`segments_json` 为该版全文快照，`decision_watermark` 界定该版可见的决议。
- `proposals`：修订提议；记录段号、码点范围、替换文字、依据、**基版 `base_version_id`**、
  基版原文摘录、状态机（pending → adopted/rejected/conflicted → published）与冲突原因。
  `conflict_kind` 区分冲突类别（`base_expired` 基版已过期 / `overlap` 范围交叠，旧库打开时自动补列并按原因文本回填）；
  `rebased_from_id` 记录续提来源——由哪个“基版已过期”冲突提议换算重提而来，双向可追溯。
- `decisions`：决议审计流（adopt / reject / conflict / rebase / publish），不可变追加。
- `objections` + `objection_anchors`：异议主表（含永久原文快照）与逐版本锚点；
  发布时按修订映射，相交即置 `needs_relocation`。`objection_logs` 记录创建、重定位与回应操作。
- `objection_responses`：发布前异议回应。草稿唯一（同一异议同时仅一条 `draft`）；
  `touched_proposal_ids_json` / `stage_fingerprint` / `anchor_*` 记录回应绑定的采纳提议集合、
  回应时暂存区快照与异议当前锚点；发布成功后置 `published` 并回填 `published_version_id`，
  在对应历史版本只读展示。
- `publish_schedules`：预约发布。`scheduled_at_ms` 为预约时刻（epoch 毫秒，UTC 绝对时刻），
  `scheduled_at_input` 保留原始含偏移时间字符串；`stage_snapshot_json` / `touched_snapshot_json`
  固化预约时的**采纳提议内容与集合**及**受影响异议、锚点与有效回应（id+说明）关联**。
  状态机 `pending → published / invalid / cancelled`；同一时刻至多一条 `pending`（事务内保证）。
  到期事务内逐项重核对快照与当前发布条件：一致才落版并回填 `published_version_id`；
  不一致仅写 `invalid_reason` / `invalid_details_json` 与 `fired_at_ms`，不改动版本、提议与决议。

---

## 八、发布前异议回应：HTTP 调用示例

以下示例使用 `curl`（会话 Cookie 由 `/api/login` 下发；请先以 `reviewer` 登录）。

```bash
# 1) 复核员登录（保存会话 Cookie）
curl -c rev.cookie -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"reviewer","password":"reviewer123"}'

# 2) 采纳修订进入暂存区后，查看发布前复核清单
curl -b rev.cookie http://localhost:3000/api/review-checklist
# {
#   "versionId": 3, "stageCount": 1,
#   "items": [{
#     "objectionId": 1,
#     "anchor": {"seg": 2, "start": 9, "end": 18},
#     "touchedProposalIds": [12],
#     "state": "missing",            // missing 待回应 | invalid 回应已失效 | responded 已回应 | orphan 草稿不适用
#     "invalidReasons": [],
#     "response": null
#   }],
#   "counts": {"missing":1,"invalid":0,"responded":0,"orphan":0}
# }

# 3) 逐条回应（说明必填非空；关联对象由服务端按当时状态绑定）
curl -b rev.cookie -X POST http://localhost:3000/api/objections/1/respond \
  -H 'Content-Type: application/json' \
  -d '{"note":"已核对原始录音：该处日期确有争议，本次先按概括口径发布，异议留档继续核查。"}'
# {"ok":true,"responseId":7}

# 4a) 全部回应后发布成功
curl -b rev.cookie -X POST http://localhost:3000/api/publish \
  -H 'Content-Type: application/json' -d '{"note":"日期概括修订"}'
# {"ok":true,"versionId":4}

# 4b) 仍有缺失/失效回应时，发布被拒绝且不改任何状态
# HTTP 409
# {
#   "error": "发布被拒绝：以下被暂存修订触及的异议尚有 1 条未逐条回应或回应已失效：#1；……",
#   "code": "PENDING_OBJECTION_RESPONSES",
#   "details": {"versionId":3,"blocking":[
#     {"objectionId":1,"state":"missing","invalidReasons":["尚未回应"]}
#   ]}
# }

# 5) 关联发生变化（如驳回了触及该异议的采纳提议、或异议被重新定位）后可撤回草稿重填
curl -b rev.cookie -X DELETE http://localhost:3000/api/objections/1/response

# 6) 历史版本只读查看随该版固化的回应
curl -b rev.cookie http://localhost:3000/api/versions/4
# responses: [{ objectionId:1, note:"……", touchedProposalIds:[12],
#               anchorSeg:2, anchorStart:9, anchorEnd:18,
#               responderName:"复核员", responderUser:"reviewer", ... }]
```

> 网页端：复核员在右侧“异议”面板与正文下方“发布条”均可看到**待回应项与失效原因**，
> 有待回应/失效回应时“发布新版本”按钮置灰；点击“填写回应/重新回应”即可处理。
> 历史版本弹窗的“异议”与“发布前异议回应”分区只读展示固化结果。

---

## 九、预约发布：HTTP 调用示例

以下示例使用 `curl`（请先以 `reviewer` 登录并采纳修订进入暂存区；被触及异议须已逐条回应）。

```bash
# 1) 复核员登录
curl -c rev.cookie -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"reviewer","password":"reviewer123"}'

# 2) 创建预约：scheduledAt 必须带 UTC 偏移（Z 或 ±HH:MM），且为严格未来时间；note（版本说明）必填
curl -b rev.cookie -X POST http://localhost:3000/api/schedules \
  -H 'Content-Type: application/json' \
  -d '{"scheduledAt":"2026-10-01T09:30:00+08:00","note":"国庆后统一发布日期概括修订"}'
# {"ok":true,"id":3,"scheduledAtMs":1790789400000}
# 同一绝对时刻也可写作 "2026-10-01T01:30:00Z"（+08:00 与 Z 等价）；也接受 epoch 毫秒数。

# 3) 查看预约（全部登录用户可读）：/api/booth 同样携带 schedule / recentSchedules
curl -b rev.cookie http://localhost:3000/api/schedules
# {
#   "pending": {
#     "id": 3, "status": "pending", "statusLabel": "待执行",
#     "scheduledAtMs": 1790789400000,
#     "scheduledAtUtc": "2026-10-01T01:30:00.000Z",
#     "scheduledAtInput": "2026-10-01T09:30:00+08:00",
#     "note": "国庆后统一发布日期概括修订",
#     "baseVersionId": 13,
#     "stageProposalIds": [24, 25],
#     "createdBy": "复核员", "createdByUser": "reviewer",
#     "createdAt": "2026-09-30 09:00:00",
#     "notPublishedReason": "等待到达预约时间（2026-10-01T01:30:00.000Z）"
#   },
#   "recent": [ ... ]
# }

# 4) 执行前取消
curl -b rev.cookie -X DELETE http://localhost:3000/api/schedules/3
# {"ok":true,"id":3}
```

常见拒绝（均为 4xx，中文原因，且不改变任何状态）：

```text
400 INVALID_SCHEDULE_TIME  预约时间无效：须为带 UTC 偏移的 ISO 8601 时间 / 日期不存在 / 偏移超出范围
400 TIME_NOT_FUTURE        预约时间必须是严格晚于当前时刻的未来时间
400 BAD_REQUEST           版本说明不能为空
409 EMPTY_PUBLISH         暂存区中没有已采纳修订
409 PENDING_OBJECTION_RESPONSES  被触及异议尚有缺失/失效回应（details 携带结构化清单）
409 SCHEDULE_EXISTS       已存在待执行预约，同一时刻仅允许一个；请先取消后再重新预约
409 SCHEDULE_NOT_PENDING  只能取消待执行预约（已发布/已失效/已取消）
```

到期执行结果同样可在 `GET /api/schedules`（或 `/api/booth`）查看：

- 成功：`status="published"`、`publishedVersionId` 指向新生成的不可变版本；回应随该版本固化（`GET /api/versions/:id` 只读可见）。
- 失效：`status="invalid"`，`invalidReason` / `notPublishedReason` 说明是**当前版本变化（可能已人工发布）、采纳提议集合或内容变化、
  受影响异议/锚点变化、回应被修改或撤回、还是当前发布条件不再满足**；版本、提议与决议均未改变，重新预约即可。

> 调度行为：服务每次启动都会立即核查一次（重启期间错过的逾期预约会立刻补处理），之后每 `SCHEDULE_TICK_MS`（默认 1 秒）轮询。
> 核对与落版在同一数据库事务（`BEGIN IMMEDIATE`）内完成；与人工发布并发或定时器重复触发时，至多生成一个新版本。

---

## 七、目录结构

```
.
├── Dockerfile               # 多阶段构建（原生模块编译 + 精简运行镜像）
├── docker-compose.yml       # 一键启动，含数据卷与健康检查
├── .env.example             # 配置样例（端口、会话、种子账户）
├── package.json
├── sample-transcript.txt    # 示例逐字稿
├── src
│   ├── server.js            # Express 路由与错误出口
│   ├── scheduler.js         # 预约发布调度：启动即核查逾期项 + 定时轮询，事务内执行/失效
│   ├── auth.js              # Cookie 会话与角色鉴权
│   ├── db.js                # SQLite 连接、建表、种子账户
│   ├── store.js             # 业务核心：导入/提议/复核/发布/续提/异议/预约发布/版本视图
│   └── text.js              # 码点偏移、范围校验、合版、引用映射、续提换算
├── public                   # 浏览器前端（原生 HTML/CSS/JS，无构建步骤）
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── test
    ├── unit.test.js         # 文本算子与解析的单元测试
    └── e2e.test.js          # 临时库 + 真实 HTTP 的端到端测试
```
