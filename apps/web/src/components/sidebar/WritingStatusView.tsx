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
  // Section labels come from the vault, not from this file: the panel is
  // annotating the author's own headings, so a non-Chinese vault must not be
  // captioned in Chinese. UI chrome elsewhere stays Chinese by design.
  const heading = data.sectionHeadings;
  const target = (sectionHeading: string): CanonSectionRef | undefined =>
    sections.find((section) => section.headingPath.at(-1) === sectionHeading);
  const stopSection = target(heading.stopPoint);
  const stopPointSpec = createSidebarEntryMenuSpec({
    label: heading.stopPoint,
    sourceFile,
    source: null,
    showJump: false,
    repairSection: stopSection,
    actions: {
      repair: onRepair,
      copyName: async () => {
        await copyText(heading.stopPoint, '词条名已复制');
      },
      copyEntry: async () => {
        await copyText(`${heading.stopPoint}\n${data.stopPoint}`, '词条已复制');
      },
    },
  });
  return (
    <div className="dto-root">
      {(data.lastRefreshed || data.stopChapter !== null) && (
        <div className="dto-meta-line">
          {data.stopChapter !== null && (
            <span>{heading.stopPoint}：{displayedStopChapterLabel}</span>
          )}
          {data.lastRefreshed && <span>刷新：{data.lastRefreshed}</span>}
        </div>
      )}

      {data.stopPoint && (
        <div
          className="dto-card pinned"
          data-canon-heading={heading.stopPoint}
          tabIndex={0}
          onContextMenu={(event) => menu.openFromEvent(event, stopPointSpec)}
          onKeyDown={(event) => menu.openFromKeyboard(event, stopPointSpec)}
        >
          <div className="dto-card-head">
            {heading.stopPoint}
            <CanonRepairButton section={stopSection} onRepair={onRepair} />
          </div>
          <div className="dto-body">{data.stopPoint}</div>
        </div>
      )}

      {data.storylines.length > 0 && (
        <section className="dto-block">
          <h3 className="dto-block-title">{heading.storylines} <CanonRepairButton section={target(heading.storylines)} onRepair={onRepair} /></h3>
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
          <h3 className="dto-block-title">{heading.activeForeshadow} <CanonRepairButton section={target(heading.activeForeshadow)} onRepair={onRepair} /></h3>
          <div className="md-table-wrap">
            <table className="dto-table">
              <thead>
                <tr>
                  <th>{data.activeForeshadowColumns.id}</th>
                  <th>{data.activeForeshadowColumns.content}</th>
                  <th>{data.activeForeshadowColumns.status}</th>
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
          <h3 className="dto-block-title">{heading.characterOneLiners} <CanonRepairButton section={target(heading.characterOneLiners)} onRepair={onRepair} /></h3>
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
            <AlertTriangleIcon size={14} className="danger-icon" /> {heading.redLines}
            <CanonRepairButton section={target(heading.redLines)} onRepair={onRepair} />
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
          <h3 className="dto-block-title">{heading.expressionBaseline} <CanonRepairButton section={target(heading.expressionBaseline)} onRepair={onRepair} /></h3>
          <div className="dto-body">{data.expressionBaseline}</div>
        </section>
      )}
      <ContextMenu state={menu.state} onClose={menu.close} />
    </div>
  );
}
