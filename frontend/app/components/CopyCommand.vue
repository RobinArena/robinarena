<script setup lang="ts">
const props = defineProps<{
  command: string;
}>();

const { copy, copied } = useClipboard({ copiedDuring: 1600 });

function copyCommand() {
  return copy(props.command);
}
</script>

<template>
  <div class="command-copy">
    <code>{{ command }}</code>
    <button
      type="button"
      :aria-label="copied ? `${command} copied` : `Copy ${command}`"
      @click="copyCommand"
    >
      <Icon :name="copied ? 'ph:check' : 'ph:copy'" aria-hidden="true" />
      <span>{{ copied ? "Copied" : "Copy" }}</span>
    </button>
  </div>
</template>
