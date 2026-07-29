import type { ConflictCheckResponse } from '@writing-studio/contract';
import { groupConflictFindings } from '../lib/conflict-check.js';

const SEVERITY_LABEL = {
  high: '高风险',
  medium: '中风险',
  low: '低风险',
} as const;

const TYPE_LABEL = {
  character: '角色',
  setting: '设定',
  timeline: '时间线',
  other: '其他',
} as const;

export function ConflictFindingsPanel({
  response,
  rawText = '',
  onLocateText,
  onOpenCanon,
  onRepairCanon,
}: {
  response: ConflictCheckResponse | null;
  rawText?: string;
  onLocateText: (quote: string) => void;
  onOpenCanon: (docId: string, heading: string) => void;
  onRepairCanon: (docId: string, heading: string, textQuote: string) => void;
}): React.JSX.Element {
  if (!response) {
    return (
      <section className="conflict-results parse-fallback" aria-label="冲突检查结果">
        <div className="conflict-honesty">解析失败，请人工阅读</div>
        <pre>{rawText}</pre>
      </section>
    );
  }
  if (response.findings.length === 0) {
    return (
      <section className="conflict-results" aria-label="冲突检查结果">
        <div className="conflict-honesty">AI 初筛，可能漏检误报</div>
        <div className="conflict-empty">未发现冲突（AI 初筛）</div>
      </section>
    );
  }
  return (
    <section className="conflict-results" aria-label="冲突检查结果">
      <div className="conflict-honesty">AI 初筛，可能漏检误报；请按正典出处核验。</div>
      {groupConflictFindings(response.findings).map(([severity, findings]) => (
        <div className={`conflict-group ${severity}`} key={severity}>
          <div className="conflict-group-title">
            <strong>{SEVERITY_LABEL[severity]}</strong>
            <span>{findings.length} 条</span>
          </div>
          {findings.map((finding, index) => (
            <article className="conflict-finding" key={`${finding.textQuote}-${index}`}>
              <div className="conflict-finding-meta">
                <span>{TYPE_LABEL[finding.conflictType]}</span>
                <strong>{finding.claimInText}</strong>
              </div>
              <button
                type="button"
                className="conflict-quote"
                onClick={() => onLocateText(finding.textQuote)}
              >
                “{finding.textQuote}”
              </button>
              <button
                type="button"
                className="conflict-canon-link"
                onClick={() => onOpenCanon(
                  finding.canonSource.docId,
                  finding.canonSource.heading,
                )}
              >
                {finding.canonSource.docId} · {finding.canonSource.heading}
              </button>
              <button
                type="button"
                className="btn conflict-canon-repair"
                onClick={() => onRepairCanon(
                  finding.canonSource.docId,
                  finding.canonSource.heading,
                  finding.textQuote,
                )}
              >
                修补正典
              </button>
              <p>{finding.explanation}</p>
            </article>
          ))}
        </div>
      ))}
    </section>
  );
}
