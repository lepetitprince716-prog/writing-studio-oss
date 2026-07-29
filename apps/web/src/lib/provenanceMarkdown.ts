import type { ProvenanceResponse, RevisionKind } from '@writing-studio/contract';

const KIND_LABEL: Record<RevisionKind, string> = {
  ai_original: 'AI 初稿',
  user_edit: '作者编辑',
  manual_snapshot: '手动快照',
};

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds <= 0) return '0 分钟';
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours} 小时` : `${hours} 小时 ${remainder} 分钟`;
}

export function buildProvenanceMarkdown(
  provenance: ProvenanceResponse,
  formatDate: (timestamp: number) => string = (timestamp) => new Date(timestamp).toLocaleString(),
): string {
  const { summary } = provenance;
  const lines = [
    `# ${escapeCell(provenance.title)}｜编辑自证包`,
    '',
    `- 文档：\`${provenance.docId}\``,
    `- AI 初稿字数：${summary.aiDraftWordCount}`,
    `- 作者累计改动字符数：${summary.authorChangedChars}`,
    `- 修订次数：${summary.revisionCount}`,
    `- 时间跨度：${formatDuration(summary.timeSpanMs)}`,
    '',
    '## 修订时间线',
    '',
  ];
  if (provenance.revisions.length === 0) {
    lines.push('暂无修订记录。', '');
  } else {
    lines.push('| 时间 | 类型 | 字数 | 新增字符 | 删除字符 |', '|---|---:|---:|---:|---:|');
    for (const revision of provenance.revisions) {
      lines.push(
        `| ${escapeCell(formatDate(revision.createdAt))} | ${KIND_LABEL[revision.kind]} | ${revision.wordCount} | +${revision.addedChars} | -${revision.deletedChars} |`,
      );
    }
    lines.push('');
  }
  lines.push('> 本文件依据 Writing Studio 的本地不可变修订记录生成，仅汇总编辑过程，不包含正文内容。', '');
  return lines.join('\n');
}
