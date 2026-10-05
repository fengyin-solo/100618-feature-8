# 盾构隧道掘进施工管理平台

面向盾构机台账、掘进环次、管片拼装、同步注浆、渣土外运、地表沉降监测与轴线纠偏的一体化盾构隧道施工管理平台。

这是一个**纯前端**管理平台：Vue 3 + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 Vue 3 + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 盾构机台账 | `shield` | 盾构机 | 盾构机编号、盾构机型号、开挖直径 |
| 掘进环次 | `ring` | 掘进环 | 环号、起始里程、掘进速度 |
| 管片拼装 | `segment` | 管片环 | 管片环号、管片型号、拼装点位 |
| 同步注浆 | `grouting` | 注浆记录 | 注浆编号、对应环号、浆液配比 |
| 渣土外运 | `muck` | 渣土运输单 | 运输单号、对应环号、渣土方量 |
| 地表沉降 | `settlement` | 沉降测点 | 测点编号、测点位置、初始高程 |
| 轴线偏差 | `axis` | 轴线测量 | 测量编号、对应环号、设计轴线 |
| 刀具磨损 | `cutter` | 刀具 | 刀具编号、刀盘位置、刀具类型 |
| 管片生产 | `segmentprod` | 管片 | 管片编号、管片型号、生产模具 |
| 浆液拌制 | `mortar` | 浆液批次 | 批次编号、浆液类型、水泥用量 |
| 洞内通风 | `ventilation` | 通风机组 | 机组编号、风筒长度、送风量 |
| 建筑监测 | `building` | 监测对象 | 对象编号、建筑物名称、结构类型 |
| 管线探查 | `utility` | 地下管线 | 管线编号、管线类型、埋设深度 |
| 进度节点 | `progress` | 进度节点 | 节点编号、节点名称、计划完成日 |
| 试验检测 | `testing` | 试验委托 | 委托编号、试样类型、检测项目 |
| 应急演练 | `drill` | 应急演练 | 演练编号、演练科目、演练日期 |
| 班组进场 | `crew` | 施工班组 | 班组编号、班组名称、主要工种 |
| 安全巡检 | `safety` | 巡检记录 | 巡检编号、巡检区域、巡检项目 |

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `shield-tunnel-construction:entries` 这一项，或调用 `resetModule(模块)`。

## 管片拼装领域（segment）

管片拼装有独立的领域服务 `frontend/src/api/segment-service.ts`，页面与管片生产页都只读这一份：

- **同一份取数**：环（`segment`）、验收记录（`segment_acceptance`）、返工单（`segment_rework`）
  都收在既有 localStorage 键、既有内存 cache，沿用既有读取方式。任何写入先整表序列化、
  写库成功后才更新内存；写库失败就地整笔撤销，不存在只落一半。
- **保存成功前不回显**：管片环号、拼装点位、螺栓扭矩、错台量在弹窗里只是草稿，
  成功落库后列表才出现新值；刷新、返回、重新进入读到的都是落库那份。
- **进度状态机**：待拼装 → 拼装中 → 已验收，跳着改一律驳回并说明缺了哪一步。
  登记返工把验收时的「复核意见」清空并退回待拼装，不单设「已返工」状态。
- **幂等**：同一环同一轮重复提交验收只落一条验收记录；未闭环返工单存在时重复登记不再出第二张。
- **班组权限**：拼装点位只有本环拼装班组能改，跨班组操作一律打回（顶栏可切换当前班组演示）。
- **返工回写**：返工结论通过 `pendingReworkRings()` 出现在管片生产页「出厂待办」，
  待返工环数=去重后「挂未闭环返工单且环未重新验收」的环数，两处共用同一 selector，不会有两个数。
- **存量重放**：版本键 `shield-tunnel-construction:segment-version` 升级时，
  旧拼装记录按拼装日期升序重新过一遍，旧「已返工」环退回待拼装并补开返工单。

领域规则可用以下命令做无浏览器校验（`scripts/verify-segment.mjs`，共 49 条断言）：

```bash
cd frontend
npm run verify:segment
```
