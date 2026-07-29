/**
 * 写作状态 view: pinned stop-point card, storyline status, active foreshadow
 * table, one-line character states, and the numbered red-line checklist.
 */

import type {
  CanonSectionRef,
  ContentTreeLeaf,
  WritingStatusDto,
} from '@writing-studio/contract';
import { copyText } from '../../lib/clipboard.js';
import { formatChapterLabel } from '../../lib/chapter-label.js';
import { ContextMenu, useContextMenu } from '../ContextMenu.js';
import { AlertTriangleIcon } from '../icons.js';
import { CanonRepairButton } from './CanonRepairButton.js';
import {
  createSidebarEntryMenuSpec,
} from './sidebar-menu-specs.js';

export function WritingStatusView({
  data,
  sections,
  onRepair,
  sourceFile,
  chapterLeaf,
}: {
  data: WritingStatusDto;
  sections: CanonSectionRef[];
  onRepair: (section: CanonSectionRef) => void;
  sourceFile: string;
  chapterLeaf: ContentTreeLeaf | null | undefined;
}): React.JSX.Element {
  const menu = useContextMenu();
  // The no-template fallback keeps this view's historical spaced form
  // directly; configured templates are rendered byte-for-byte.
  const displayedStopChapterLabel = data.stopChapter === null
    ? ''
    : chapterLeaf?.titleTemplate == null
      ? `第 ${data.stopChapter} 章`
      : formatChapterLabel(chapterLeaf, data.stopChapter);
  const target = (heading: string): CanonSectionRef | undefined =>
    sections.find((section) => section.headingPath.at(-1) === heading);
  const stopSection = target(data.sectionHeadings.stopPoint);
  const stopPointSpec = createSidebarEntryMenuSpec({
    label: '停点',
    sourceFile,
    source: null,
    showJump: false,
    repairSection: stopSection,
    actions: {
      repair: onRepair,
      copyName: async () => {
        await copyText('停点', '词条名已复制');
      },
      copyEntry: async () => {
        await copyText(`停点\n${data.stopPoint}`, '词条已复制');
      },
    },
  });
  return (
    <div className="dto-root">
      {(data.lastRefreshed || data.stopChapter !== null) && (
        <div className="dto-meta-line">
          {data.stopChapter !== null && (
            <span>停点：{displayedStopChapterLabel}</span>
          )}
          {data.lastRefreshed && <span>刷新：{data.lastRefreshed}</span>}
        </div>
      )}

      {data.stopPoint && (
        <div
          className="dto-card pinned"
          data-canon-heading="停点"
          tabIndex={0}
          onContextMenu={(event) => menu.openFromEvent(event, stopPointSpec)}
          onKeyDown={(event) => menu.openFromKeyboard(event, stopPointSpec)}
        >
          <div className="dto-card-head">
            停点
            <CanonRepairButton section={stopSection} onRepair={onRepair} />
          </div>
          <div className="dto-body">{data.stopPoint}</div>
        </div>
      )}

      {data.storylines.length > 0 && (
        <section className="dto-block">
          <h3 className="dto-block-title">故事线 <CanonRepairButton section={target(data.sectionHeadings.storylines)} onRepair={onRepair} /></h3>
          {data.storylines.map((line) => (
            <div className="dto-line-item" key={line.name}>
              <span className="dto-term">{line.name}</span>
              <span className="dto-body">{line.body}</span>
            </div>
          ))}
        </section>
      )}

      {data.activeForeshadow.length > 0 && (
        <section className="dto-block">
          <h3 className="dto-block-title">活跃伏笔 <CanonRepairButton section={target(data.sectionHeadings.activeForeshadow)} onRepair={onRepair} /></h3>
          <div className="md-table-wrap">
            <table className="dto-table">
              <thead>
                <tr>
                  <th>编号</th>
                  <th>内容</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {data.activeForeshadow.map((f) => (
                  <tr key={f.id}>
                    <td className="foreshadow-id">{f.id}</td>
                    <td>{f.content}</td>
                    <td>{f.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {data.characterOneLiners.length > 0 && (
        <section className="dto-block">
          <h3 className="dto-block-title">角色一句话 <CanonRepairButton section={target(data.sectionHeadings.characterOneLiners)} onRepair={onRepair} /></h3>
          {data.characterOneLiners.map((c) => (
            <div className="dto-line-item" key={c.name}>
              <span className="dto-term">{c.name}</span>
              <span className="dto-body">{c.text}</span>
            </div>
          ))}
        </section>
      )}

      {data.redLines.length > 0 && (
        <section className="dto-block">
          <h3 className="dto-block-title">
            <AlertTriangleIcon size={14} className="danger-icon" /> 写作红线
            <CanonRepairButton section={target(data.sectionHeadings.redLines)} onRepair={onRepair} />
          </h3>
          <ol className="red-line-list">
            {data.redLines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ol>
        </section>
      )}

      {data.expressionBaseline && (
        <section className="dto-block">
          <h3 className="dto-block-title">表达基线 <CanonRepairButton section={target(data.sectionHeadings.expressionBaseline)} onRepair={onRepair} /></h3>
          <div className="dto-body">{data.expressionBaseline}</div>
        </section>
      )}
      <ContextMenu state={menu.state} onClose={menu.close} />
    </div>
  );
}
