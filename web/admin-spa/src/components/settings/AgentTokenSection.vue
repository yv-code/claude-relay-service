<template>
  <div>
    <!-- 状态卡片 -->
    <div
      class="mb-6 rounded-xl border border-gray-200 bg-gradient-to-r from-emerald-50 to-teal-50 p-4 dark:border-gray-700 dark:from-emerald-900/20 dark:to-teal-900/20"
    >
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="flex items-center gap-4">
          <div
            class="flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400"
          >
            <i class="fas fa-key text-xl" />
          </div>
          <div>
            <p class="text-sm font-medium text-gray-700 dark:text-gray-300">
              Token 总数:
              <span class="font-bold text-emerald-600 dark:text-emerald-400">{{
                tokens.length
              }}</span>
              <span class="ml-3 text-gray-400">|</span>
              <span class="ml-3"
                >活跃:
                <span class="font-bold text-green-600 dark:text-green-400">{{
                  activeCount
                }}</span></span
              >
            </p>
            <p class="text-xs text-gray-500 dark:text-gray-400">
              用于外部程序查询系统状态的长效访问令牌
            </p>
          </div>
        </div>
        <button
          class="flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-600 hover:shadow-md"
          @click="showCreateDialog = true"
        >
          <i class="fas fa-plus" />
          创建 Token
        </button>
      </div>
    </div>

    <!-- 加载状态 -->
    <div v-if="loading" class="py-12 text-center">
      <i class="fas fa-spinner fa-spin mb-4 text-2xl text-emerald-500" />
      <p class="text-gray-500 dark:text-gray-400">加载中...</p>
    </div>

    <!-- 空状态 -->
    <div
      v-else-if="tokens.length === 0"
      class="rounded-xl border border-dashed border-gray-300 py-16 text-center dark:border-gray-600"
    >
      <i class="fas fa-key mb-4 text-4xl text-gray-300 dark:text-gray-600" />
      <p class="mb-2 text-gray-500 dark:text-gray-400">暂无 Agent Token</p>
      <p class="mb-4 text-sm text-gray-400 dark:text-gray-500">
        创建一个 Token 用于通过 /agent/* 接口查询系统状态
      </p>
      <button
        class="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-600"
        @click="showCreateDialog = true"
      >
        <i class="fas fa-plus mr-1" />
        创建第一个 Token
      </button>
    </div>

    <!-- Token 列表 -->
    <div v-else class="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
      <table class="min-w-full text-sm">
        <thead class="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th
              class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
            >
              名称
            </th>
            <th
              class="px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
            >
              状态
            </th>
            <th
              class="hidden px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 md:table-cell"
            >
              创建时间
            </th>
            <th
              class="hidden px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 lg:table-cell"
            >
              最后使用
            </th>
            <th
              class="hidden px-4 py-3 text-left text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 md:table-cell"
            >
              过期时间
            </th>
            <th
              class="px-4 py-3 text-right text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400"
            >
              操作
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-200 dark:divide-gray-700">
          <tr
            v-for="token in tokens"
            :key="token.id"
            class="transition hover:bg-gray-50 dark:hover:bg-gray-800/50"
          >
            <td class="px-4 py-3">
              <div class="font-medium text-gray-900 dark:text-gray-100">{{ token.name }}</div>
              <div v-if="token.description" class="text-xs text-gray-500 dark:text-gray-400">
                {{ token.description }}
              </div>
            </td>
            <td class="px-4 py-3">
              <button
                :class="[
                  'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium transition',
                  token.isActive
                    ? 'bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400'
                    : 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400'
                ]"
                @click="toggleActive(token)"
              >
                <i :class="['fas', token.isActive ? 'fa-check-circle' : 'fa-times-circle']" />
                {{ token.isActive ? '活跃' : '已禁用' }}
              </button>
            </td>
            <td
              class="hidden whitespace-nowrap px-4 py-3 text-gray-500 dark:text-gray-400 md:table-cell"
            >
              {{ formatDate(token.createdAt) }}
            </td>
            <td
              class="hidden whitespace-nowrap px-4 py-3 text-gray-500 dark:text-gray-400 lg:table-cell"
            >
              {{ token.lastUsedAt ? formatDate(token.lastUsedAt) : '从未使用' }}
            </td>
            <td
              class="hidden whitespace-nowrap px-4 py-3 text-gray-500 dark:text-gray-400 md:table-cell"
            >
              <span v-if="!token.expiresAt" class="text-gray-400">永不过期</span>
              <span
                v-else
                :class="
                  isExpired(token.expiresAt) ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'
                "
              >
                {{ formatDate(token.expiresAt) }}
                <span v-if="isExpired(token.expiresAt)" class="text-xs">(已过期)</span>
              </span>
            </td>
            <td class="whitespace-nowrap px-4 py-3 text-right">
              <div class="flex items-center justify-end gap-1">
                <button
                  class="rounded p-1.5 text-gray-400 transition hover:bg-blue-50 hover:text-blue-500 dark:hover:bg-blue-900/30"
                  title="重新生成"
                  @click="confirmRegenerate(token)"
                >
                  <i class="fas fa-sync-alt text-xs" />
                </button>
                <button
                  class="rounded p-1.5 text-gray-400 transition hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/30"
                  title="删除"
                  @click="confirmDelete(token)"
                >
                  <i class="fas fa-trash-alt text-xs" />
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 创建对话框 -->
    <div
      v-if="showCreateDialog"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      @click.self="showCreateDialog = false"
    >
      <div
        class="w-full max-w-md rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl dark:border-gray-700 dark:bg-gray-800"
      >
        <h3 class="mb-4 text-lg font-semibold text-gray-900 dark:text-gray-100">
          <i class="fas fa-plus-circle mr-2 text-emerald-500" />
          创建 Agent Token
        </h3>

        <div class="space-y-4">
          <div>
            <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
              >名称 <span class="text-red-500">*</span></label
            >
            <input
              v-model="createForm.name"
              class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 transition focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
              placeholder="例如：监控系统"
              type="text"
            />
          </div>

          <div>
            <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
              >描述</label
            >
            <input
              v-model="createForm.description"
              class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 transition focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
              placeholder="可选描述"
              type="text"
            />
          </div>

          <div>
            <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300"
              >过期设置</label
            >
            <div class="flex items-center gap-3">
              <label
                class="flex cursor-pointer items-center gap-2 text-sm text-gray-600 dark:text-gray-300"
              >
                <input
                  v-model="createForm.neverExpire"
                  class="text-emerald-500"
                  name="expiry"
                  type="radio"
                  :value="true"
                />
                永不过期
              </label>
              <label
                class="flex cursor-pointer items-center gap-2 text-sm text-gray-600 dark:text-gray-300"
              >
                <input
                  v-model="createForm.neverExpire"
                  class="text-emerald-500"
                  name="expiry"
                  type="radio"
                  :value="false"
                />
                指定日期
              </label>
            </div>
            <input
              v-if="!createForm.neverExpire"
              v-model="createForm.expiresAt"
              class="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 transition focus:border-emerald-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-200"
              type="datetime-local"
            />
          </div>
        </div>

        <div class="mt-6 flex justify-end gap-3">
          <button
            class="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            @click="showCreateDialog = false"
          >
            取消
          </button>
          <button
            :class="[
              'rounded-lg px-4 py-2 text-sm font-medium text-white transition',
              creating ? 'cursor-not-allowed bg-gray-400' : 'bg-emerald-500 hover:bg-emerald-600'
            ]"
            :disabled="creating || !createForm.name.trim()"
            @click="handleCreate"
          >
            <i v-if="creating" class="fas fa-spinner fa-spin mr-1" />
            {{ creating ? '创建中...' : '创建' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Token 显示对话框（仅创建/重新生成后显示） -->
    <div
      v-if="showTokenDialog"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
    >
      <div
        class="w-full max-w-lg rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl dark:border-gray-700 dark:bg-gray-800"
      >
        <h3 class="mb-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
          <i class="fas fa-check-circle mr-2 text-green-500" />
          {{ tokenDialogTitle }}
        </h3>
        <p class="mb-4 text-sm text-amber-600 dark:text-amber-400">
          <i class="fas fa-exclamation-triangle mr-1" />
          请立即复制此 Token，关闭后将无法再次查看！
        </p>

        <div class="relative">
          <div
            class="flex min-h-[60px] items-center break-all rounded-lg border border-gray-700 bg-gray-900 p-4 pr-14 font-mono text-sm text-green-400"
          >
            {{ newToken }}
          </div>
          <button
            class="absolute right-3 top-3 rounded p-1.5 text-gray-400 transition hover:bg-gray-700 hover:text-white"
            title="复制"
            @click="copyToken"
          >
            <i :class="['fas', copied ? 'fa-check text-green-400' : 'fa-copy']" />
          </button>
        </div>

        <div
          class="mt-4 rounded-lg border border-blue-200 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-900/20"
        >
          <p class="text-xs text-blue-700 dark:text-blue-300">
            <i class="fas fa-info-circle mr-1" />
            使用方式：在请求头中添加
            <code class="rounded bg-blue-100 px-1 dark:bg-blue-800"
              >Authorization: Bearer {{ newToken.substring(0, 12) }}...</code
            >
            访问 <code class="rounded bg-blue-100 px-1 dark:bg-blue-800">/agent/*</code> 接口
          </p>
        </div>

        <div class="mt-6 flex justify-end">
          <button
            class="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-emerald-600"
            @click="showTokenDialog = false"
          >
            我已保存
          </button>
        </div>
      </div>
    </div>

    <!-- 确认对话框 -->
    <div
      v-if="showConfirmDialog"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      @click.self="showConfirmDialog = false"
    >
      <div
        class="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-6 shadow-2xl dark:border-gray-700 dark:bg-gray-800"
      >
        <h3 class="mb-2 text-lg font-semibold text-gray-900 dark:text-gray-100">
          {{ confirmTitle }}
        </h3>
        <p class="mb-6 text-sm text-gray-500 dark:text-gray-400">{{ confirmMessage }}</p>
        <div class="flex justify-end gap-3">
          <button
            class="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
            @click="showConfirmDialog = false"
          >
            取消
          </button>
          <button
            :class="[
              'rounded-lg px-4 py-2 text-sm font-medium text-white transition',
              confirmAction === 'delete'
                ? 'bg-red-500 hover:bg-red-600'
                : 'bg-blue-500 hover:bg-blue-600'
            ]"
            @click="executeConfirm"
          >
            确认
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import {
  getAgentTokensApi,
  createAgentTokenApi,
  updateAgentTokenApi,
  deleteAgentTokenApi,
  regenerateAgentTokenApi
} from '@/utils/http_apis'
import { showToast } from '@/utils/tools'

const tokens = ref([])
const loading = ref(false)
const creating = ref(false)

// 创建表单
const showCreateDialog = ref(false)
const createForm = ref({
  name: '',
  description: '',
  neverExpire: true,
  expiresAt: ''
})

// Token 显示
const showTokenDialog = ref(false)
const tokenDialogTitle = ref('')
const newToken = ref('')
const copied = ref(false)

// 确认对话框
const showConfirmDialog = ref(false)
const confirmTitle = ref('')
const confirmMessage = ref('')
const confirmAction = ref('')
const confirmTarget = ref(null)

const activeCount = computed(() => tokens.value.filter((t) => t.isActive).length)

const loadTokens = async () => {
  loading.value = true
  try {
    const res = await getAgentTokensApi()
    if (res?.success) {
      tokens.value = res.data
    }
  } catch (error) {
    showToast('加载 Token 列表失败', 'error')
  } finally {
    loading.value = false
  }
}

const handleCreate = async () => {
  if (!createForm.value.name.trim()) return
  creating.value = true
  try {
    const data = {
      name: createForm.value.name.trim(),
      description: createForm.value.description.trim()
    }
    if (!createForm.value.neverExpire && createForm.value.expiresAt) {
      data.expiresAt = new Date(createForm.value.expiresAt).toISOString()
    }

    const res = await createAgentTokenApi(data)
    if (res?.success) {
      showCreateDialog.value = false
      createForm.value = { name: '', description: '', neverExpire: true, expiresAt: '' }

      tokenDialogTitle.value = 'Token 创建成功'
      newToken.value = res.data.token
      showTokenDialog.value = true

      await loadTokens()
      showToast('Token 创建成功', 'success')
    } else {
      showToast(res?.message || '创建失败', 'error')
    }
  } catch (error) {
    showToast('创建失败', 'error')
  } finally {
    creating.value = false
  }
}

const toggleActive = async (token) => {
  try {
    const res = await updateAgentTokenApi(token.id, { isActive: !token.isActive })
    if (res?.success) {
      token.isActive = !token.isActive
      showToast(token.isActive ? '已启用' : '已禁用', 'success')
    }
  } catch (error) {
    showToast('操作失败', 'error')
  }
}

const confirmRegenerate = (token) => {
  confirmTitle.value = '重新生成 Token'
  confirmMessage.value = `确定要重新生成「${token.name}」的密钥吗？旧密钥将立即失效。`
  confirmAction.value = 'regenerate'
  confirmTarget.value = token
  showConfirmDialog.value = true
}

const confirmDelete = (token) => {
  confirmTitle.value = '删除 Token'
  confirmMessage.value = `确定要删除「${token.name}」吗？此操作不可恢复。`
  confirmAction.value = 'delete'
  confirmTarget.value = token
  showConfirmDialog.value = true
}

const executeConfirm = async () => {
  const token = confirmTarget.value
  showConfirmDialog.value = false

  if (confirmAction.value === 'regenerate') {
    try {
      const res = await regenerateAgentTokenApi(token.id)
      if (res?.success) {
        tokenDialogTitle.value = 'Token 已重新生成'
        newToken.value = res.data.token
        showTokenDialog.value = true
        showToast('Token 已重新生成', 'success')
      }
    } catch (error) {
      showToast('重新生成失败', 'error')
    }
  } else if (confirmAction.value === 'delete') {
    try {
      const res = await deleteAgentTokenApi(token.id)
      if (res?.success) {
        await loadTokens()
        showToast('Token 已删除', 'success')
      }
    } catch (error) {
      showToast('删除失败', 'error')
    }
  }
}

const copyToken = async () => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(newToken.value)
    } else {
      const textarea = document.createElement('textarea')
      textarea.value = newToken.value
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }
    copied.value = true
    showToast('已复制到剪贴板', 'success')
    setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    showToast('复制失败', 'error')
  }
}

const formatDate = (dateStr) => {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return d.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

const isExpired = (dateStr) => {
  if (!dateStr) return false
  return new Date(dateStr) <= new Date()
}

onMounted(() => {
  loadTokens()
})
</script>
