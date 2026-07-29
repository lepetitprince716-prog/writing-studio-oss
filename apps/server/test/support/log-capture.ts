export type CapturedLogRecord = Record<string, unknown>;

const MAX_LOG_LINE_CONTEXT_LENGTH = 500;

export function captureJsonLogs(): {
  records: CapturedLogRecord[];
  stream: { write(message: string): void };
} {
  const records: CapturedLogRecord[] = [];
  return {
    records,
    stream: {
      write(message) {
        for (const line of message.split('\n')) {
          if (!line) continue;
          try {
            records.push(JSON.parse(line) as CapturedLogRecord);
          } catch (cause) {
            const chars = Array.from(line);
            const context = chars.length <= MAX_LOG_LINE_CONTEXT_LENGTH
              ? line
              : `${chars.slice(0, MAX_LOG_LINE_CONTEXT_LENGTH).join('')}…`;
            throw new Error(`failed to parse JSON log line: ${context}`, { cause });
          }
        }
      },
    },
  };
}
