<template>
  <section class="page" data-module="segment">
    <header class="page-head">
      <div>
        <h2>管片拼装管理</h2>
        <p class="page-desc">读写同一份落库数据：保存成功前不回显、失败整笔退回；进度按 待拼装 → 拼装中 → 已验收 流转，登记返工退回待拼装并清空复核意见。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记管片环</button>
        <button class="btn" type="button" @click="exportRows">导出管片拼装清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item crew-badge">当前班组：{{ store.crew }}</span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>复核意见</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</td>
          <td>{{ row.status }}</td>
          <td>{{ row.复核意见 || '—' }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openEdit(row)">编辑拼装</button>
            <button
              v-for="action in allowedActions(row)"
              :key="action"
              class="link"
              type="button"
              :disabled="busyKey === actionKey(action, row)"
              @click="openAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 3" class="empty-state">暂无管片拼装数据，可先登记管片环</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条管片拼装记录 · 数据保存成功后才会出现在这里，刷新、返回、重进一致</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 登记 / 编辑：表单只是草稿，保存成功前不进 store、不回显 -->
    <div v-if="formOpen" class="modal-mask" @click.self="closeForm">
      <form class="modal" @submit.prevent="submitForm">
        <h3 class="modal-title">{{ formMode === 'create' ? '登记管片环' : `编辑拼装 ${formRingNo}` }}</h3>
        <p class="modal-tip">以下内容整笔保存：任一项不合规或写库失败，整笔退回，列表数字不变。</p>
        <label class="form-item">
          <span>管片环号</span>
          <input v-model.trim="formModel.管片环号" :disabled="formMode === 'edit'" placeholder="如 R-0105" />
        </label>
        <label class="form-item">
          <span>管片型号</span>
          <input v-model.trim="formModel.管片型号" placeholder="如 标准环 B2" />
        </label>
        <label class="form-item">
          <span>拼装点位</span>
          <input
            v-model.trim="formModel.拼装点位"
            :placeholder="formMode === 'edit' && !ownsRow ? '只有本环拼装班组能修改' : '如 2点位'"
            :disabled="formMode === 'edit' && !ownsRow"
          />
        </label>
        <label class="form-item">
          <span>螺栓扭矩（kN·m）</span>
          <input v-model.trim="formModel.螺栓扭矩" placeholder="拼装完成后补齐" />
        </label>
        <label class="form-item">
          <span>错台量（mm）</span>
          <input v-model.trim="formModel.错台量" placeholder="拼装完成后补齐" />
        </label>
        <label v-if="formMode === 'create'" class="form-item">
          <span>拼装班组</span>
          <select v-model="formModel.拼装班组">
            <option v-for="crew in store.crewOptions" :key="crew" :value="crew">{{ crew }}</option>
          </select>
        </label>
        <label class="form-item">
          <span>拼装日期</span>
          <input v-model.trim="formModel.拼装日期" type="date" />
        </label>
        <p v-if="formMode === 'edit' && !ownsRow" class="error-text">当前班组 {{ store.crew }} 不是本环拼装班组，拼装点位已锁定（其余内容仍可查看）。</p>
        <p v-if="formMessage" class="error-text">{{ formMessage }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeForm">取消</button>
          <button class="btn primary" type="submit" :disabled="saving">保存</button>
        </div>
      </form>
    </div>

    <!-- 提交验收：记录复核意见 -->
    <div v-if="actionOpen && actionName === '提交验收'" class="modal-mask" @click.self="closeAction">
      <form class="modal" @submit.prevent="submitAction">
        <h3 class="modal-title">提交验收 · {{ activeRow?.管片环号 }}</h3>
        <p class="modal-tip">同一管片环重复提交验收只落一条记录，连续点击不会多出返工单。</p>
        <label class="form-item">
          <span>复核意见</span>
          <textarea v-model.trim="actionNote" rows="3" placeholder="验收时的复核结论"></textarea>
        </label>
        <p v-if="actionMessage" class="error-text">{{ actionMessage }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeAction">取消</button>
          <button class="btn primary" type="submit" :disabled="saving">确认验收</button>
        </div>
      </form>
    </div>

    <!-- 登记返工：填写返工结论，退回待拼装并清空复核意见 -->
    <div v-if="actionOpen && actionName === '登记返工'" class="modal-mask" @click.self="closeAction">
      <form class="modal" @submit.prevent="submitAction">
        <h3 class="modal-title">登记返工 · {{ activeRow?.管片环号 }}</h3>
        <p class="modal-tip">登记后管片环退回「待拼装」，验收时的复核意见当场清空；返工结论回写管片生产出厂待办，重复点击只出一张返工单。</p>
        <label class="form-item">
          <span>返工结论</span>
          <textarea v-model.trim="actionNote" rows="3" placeholder="如 错台量超差，重新对孔拼装并复拧螺栓"></textarea>
        </label>
        <p v-if="actionMessage" class="error-text">{{ actionMessage }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeAction">取消</button>
          <button class="btn primary" type="submit" :disabled="saving">确认登记返工</button>
        </div>
      </form>
    </div>

    <!-- 开始拼装：直接确认 -->
    <div v-if="actionOpen && actionName === '开始拼装'" class="modal-mask" @click.self="closeAction">
      <form class="modal" @submit.prevent="submitAction">
        <h3 class="modal-title">开始拼装 · {{ activeRow?.管片环号 }}</h3>
        <p class="modal-tip">管片环将由「待拼装」进入「拼装中」。跳着改会被驳回并提示缺了哪一步。</p>
        <p v-if="actionMessage" class="error-text">{{ actionMessage }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeAction">取消</button>
          <button class="btn primary" type="submit" :disabled="saving">确认开始</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import { downloadEntries, moduleMeta } from '@/api/local-service'
import {
  createRing,
  listSegmentRings,
  registerRework,
  saveRingProfile,
  segmentStats,
  segmentStatusSummary,
  startAssembly,
  submitAcceptance,
} from '@/api/segment-service'
import { useSessionStore } from '@/stores/session'
import {
  ASSEMBLY_CREWS,
  DEFAULT_ASSEMBLY_CREW,
  SEGMENT_STATUS,
  type SegmentDraft,
  type SegmentRing,
} from '@/data/segment-assembly'

const store = useSessionStore()
const meta = moduleMeta('segment')
const columns = ["管片环号", "管片型号", "拼装点位", "螺栓扭矩", "错台量", "拼装班组", "拼装日期", "拼装状态"]
const filterFields = columns.slice(0, 3)

const rows = ref<SegmentRing[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})

// 统计卡与状态汇总全部走领域 selector；「待返工环数」与管片生产页同一份取数。
const stats = ref(segmentStats())
const statusSummary = ref(segmentStatusSummary())

const busyKey = ref('')

function owns(row: SegmentRing): boolean {
  return row.拼装班组 === store.crew
}

// 行内只放行状态机允许的下一步；后端（领域服务）仍会二次校验，跳着改一律驳回。
function allowedActions(row: SegmentRing): string[] {
  if (!owns(row)) {
    return []
  }
  if (row.status === SEGMENT_STATUS.waiting) {
    return ['开始拼装']
  }
  if (row.status === SEGMENT_STATUS.assembling) {
    return ['提交验收']
  }
  return ['登记返工']
}

function actionKey(action: string, row: SegmentRing): string {
  return `${action}:${row.id}`
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  errorMessage.value = ''
  try {
    rows.value = listSegmentRings(filters.value)
    total.value = rows.value.length
    stats.value = segmentStats()
    statusSummary.value = segmentStatusSummary()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '管片拼装列表读取失败'
  }
}

onMounted(reload)

// ---- 登记 / 编辑草稿：未保存成功前只活在本组件里，页面表格不显示 ----

type FormMode = 'create' | 'edit'
const formOpen = ref(false)
const formMode = ref<FormMode>('create')
const formId = ref<number | null>(null)
const formRingNo = ref('')
const formMessage = ref('')
const saving = ref(false)
const ownsRow = ref(true)

function emptyDraft(): SegmentDraft {
  return {
    管片环号: '',
    管片型号: '',
    拼装点位: '',
    螺栓扭矩: '',
    错台量: '',
    拼装班组: store.crew,
    拼装日期: new Date().toISOString().slice(0, 10),
  }
}

const formModel = ref<SegmentDraft>(emptyDraft())

function openCreate() {
  formMode.value = 'create'
  formId.value = null
  formRingNo.value = ''
  formModel.value = emptyDraft()
  formMessage.value = ''
  ownsRow.value = true
  formOpen.value = true
}

function openEdit(row: SegmentRing) {
  formMode.value = 'edit'
  formId.value = Number(row.id)
  formRingNo.value = row.管片环号
  ownsRow.value = owns(row)
  formModel.value = {
    管片环号: row.管片环号,
    管片型号: row.管片型号,
    拼装点位: row.拼装点位,
    螺栓扭矩: String(row.螺栓扭矩 ?? ''),
    错台量: String(row.错台量 ?? ''),
    拼装班组: (ASSEMBLY_CREWS as readonly string[]).includes(row.拼装班组)
      ? row.拼装班组
      : DEFAULT_ASSEMBLY_CREW,
    拼装日期: row.拼装日期,
  }
  formMessage.value = ''
  formOpen.value = true
}

function closeForm() {
  formOpen.value = false
}

function submitForm() {
  if (saving.value) {
    return
  }
  formMessage.value = ''
  saving.value = true
  try {
    const result =
      formMode.value === 'create'
        ? createRing(formModel.value)
        : saveRingProfile(formId.value as number, store.crew, formModel.value)
    if (!result.ok) {
      // 保存被驳回或写库失败：草稿原样留在弹窗里，列表仍展示落库那份，没有半笔。
      formMessage.value = result.message
      return
    }
    formOpen.value = false
    reload()
  } finally {
    saving.value = false
  }
}

// ---- 状态流转：开始拼装 / 提交验收 / 登记返工 ----

const actionOpen = ref(false)
const actionName = ref('')
const activeRow = ref<SegmentRing | null>(null)
const actionNote = ref('')
const actionMessage = ref('')

function openAction(action: string, row: SegmentRing) {
  actionName.value = action
  activeRow.value = row
  actionNote.value = ''
  actionMessage.value = ''
  actionOpen.value = true
}

function closeAction() {
  actionOpen.value = false
  activeRow.value = null
}

function submitAction() {
  const row = activeRow.value
  if (!row || saving.value) {
    return
  }
  actionMessage.value = ''
  saving.value = true
  busyKey.value = actionKey(actionName.value, row)
  try {
    const result =
      actionName.value === '开始拼装'
        ? startAssembly(Number(row.id), store.crew)
        : actionName.value === '提交验收'
          ? submitAcceptance(Number(row.id), store.crew, actionNote.value)
          : registerRework(Number(row.id), store.crew, actionNote.value)
    if (!result.ok) {
      actionMessage.value = result.message
      return
    }
    closeAction()
    reload()
  } finally {
    saving.value = false
    busyKey.value = ''
  }
}
</script>
