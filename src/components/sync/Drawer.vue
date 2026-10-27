<!--
  ============================================================
   作者：沐晖
   日期：2026-10-22
   版权声明：本代码归沐晖所有。
     · 禁止滥用本人代码（含用于违法违规、恶意攻击、侵犯他人权益等用途）；
     · 禁止在未经本人授权的情况下直接搬运本代码（含复制、转载、用于商业项目）。
     此注释为版权与授权声明，禁止删除。
  ============================================================
-->
<script setup lang="ts">
defineProps<{
  show: boolean;
  title: string;
  rows: { k: string; v: string }[];
}>();
defineEmits<{ (e: "close"): void }>();
</script>

<template>
  <Teleport to="body">
    <div class="overlay sync-scope" :class="{ show }" @click="$emit('close')"></div>
    <aside class="drawer sync-scope" :class="{ show }">
      <div class="d-head">
        <h3>{{ title }}</h3>
        <button class="d-close" @click="$emit('close')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="d-body">
        <div v-for="(r, i) in rows" :key="i" class="kv">
          <span class="k">{{ r.k }}</span>
          <span class="v mono">{{ r.v }}</span>
        </div>
      </div>
    </aside>
  </Teleport>
</template>
