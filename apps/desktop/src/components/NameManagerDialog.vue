<script setup lang="ts">
/**
 * 通用「名称列表管理」弹窗：新增 / 重命名 / 删除。
 * 用于收入分类、往来单位等只有一个名称字段的基础数据。
 * 数据读写由父组件通过回调完成，本组件只负责交互。
 */
import { ElMessage, ElMessageBox } from 'element-plus';
import { ref, watch } from 'vue';
import { errorMessage } from '@/utils/format';

export interface ManagedItem {
  id: string;
  name: string;
  /** 内置项：只读展示，不可编辑/删除 */
  builtin?: boolean;
  /** 被流水使用的笔数，用于删除确认提示 */
  usageCount?: number;
}

const props = defineProps<{
  modelValue: boolean;
  title: string;
  /** 实体称呼，如「分类」「往来单位」 */
  noun: string;
  items: ManagedItem[];
  /** 删除已被使用的项后，流水的变化说明，如「将改为「其他收入」」 */
  usedHint: (item: ManagedItem) => string;
  onCreate: (name: string) => Promise<ManagedItem | void>;
  onRename: (id: string, name: string) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();

const newName = ref('');
const editingId = ref('');
const editingName = ref('');

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      newName.value = '';
      editingId.value = '';
    }
  }
);

async function add() {
  const name = newName.value.trim();
  if (!name) return;
  try {
    await props.onCreate(name);
    newName.value = '';
    ElMessage.success(`已新增${props.noun}`);
  } catch (e) {
    ElMessage.error(errorMessage(e));
  }
}

function startEdit(item: ManagedItem) {
  editingId.value = item.id;
  editingName.value = item.name;
}

async function save(item: ManagedItem) {
  const name = editingName.value.trim();
  if (!name) return;
  if (name === item.name) {
    editingId.value = '';
    return;
  }
  try {
    await props.onRename(item.id, name);
    editingId.value = '';
    ElMessage.success('已保存');
  } catch (e) {
    ElMessage.error(errorMessage(e));
  }
}

async function remove(item: ManagedItem) {
  const used = item.usageCount ?? 0;
  const tip =
    used > 0
      ? `${props.noun}「${item.name}」已被 ${used} 笔流水使用，删除后${props.usedHint(item)}。确定删除吗？`
      : `确定删除${props.noun}「${item.name}」吗？`;
  try {
    await ElMessageBox.confirm(tip, `删除${props.noun}`, { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' });
  } catch {
    return; // 取消
  }
  try {
    await props.onRemove(item.id);
    if (editingId.value === item.id) editingId.value = '';
    ElMessage.success('已删除');
  } catch (e) {
    ElMessage.error(errorMessage(e));
  }
}
</script>

<template>
  <el-dialog :model-value="modelValue" :title="title" width="420px" append-to-body @update:model-value="emit('update:modelValue', $event)">
    <div class="add-row">
      <el-input v-model="newName" :placeholder="`新${noun}名称`" maxlength="100" @keyup.enter="add" />
      <el-button type="primary" :disabled="!newName.trim()" @click="add">新增</el-button>
    </div>
    <el-table :data="items" size="small" border max-height="360">
      <el-table-column :label="`${noun}名称`">
        <template #default="{ row }">
          <el-input
            v-if="editingId === row.id"
            v-model="editingName"
            size="small"
            maxlength="100"
            @keyup.enter="save(row)"
            @keyup.esc="editingId = ''"
          />
          <span v-else>{{ row.name }}</span>
          <el-tag v-if="row.builtin" size="small" type="info" style="margin-left: 8px">默认</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="130" align="center">
        <template #default="{ row }">
          <el-text v-if="row.builtin" type="info" size="small">不可编辑</el-text>
          <template v-else-if="editingId === row.id">
            <el-button link type="primary" :disabled="!editingName.trim()" @click="save(row)">保存</el-button>
            <el-button link @click="editingId = ''">取消</el-button>
          </template>
          <template v-else>
            <el-button link type="primary" @click="startEdit(row)">编辑</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </template>
      </el-table-column>
    </el-table>
  </el-dialog>
</template>

<style scoped>
.add-row {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}
</style>
