/**
 * 角色 view: an accordion per character; expanding a card reveals its
 * grouped sections (heading + body). Each card offers a roleplay entry that
 * starts a writer-profile chat thread with that character.
 */

import { useReducer, useRef, useState } from 'react';
import type { CanonSectionRef, CharacterCard } from '@writing-studio/contract';
import { api } from '../../api.js';
import { formatChapterLabel } from '../../lib/chapter-label.js';
import { copyText } from '../../lib/clipboard.js';
import { useStudio } from '../../store.js';
import {
  initialMemoryCutoffState,
  isMemoryCutoffValid,
  memoryCutoffReducer,
  resolveMemoryCutoffChapter,
} from '../../lib/memory-cutoff.js';
import { ChevronRightIcon } from '../icons.js';
import { ContextMenu, useContextMenu } from '../ContextMenu.js';
import { Empty } from '../Empty.js';
import { Modal } from '../Modal.js';
import {
  MentionResults,
  mentionUiReducer,
  normalizeMentions,
} from './CharacterMentions.js';
import { CanonRepairButton } from './CanonRepairButton.js';
import {
  createSidebarEntryMenuSpec,
} from './sidebar-menu-specs.js';

function Card({
  card,
  defaultOpen,
  sections,
  onRepair,
  latestChapter,
  sourceFile,
  openEntryMenu,
}: {
  card: CharacterCard;
  defaultOpen: boolean;
  sections: CanonSectionRef[];
  onRepair: (section: CanonSectionRef) => void;
  latestChapter: number | null;
  sourceFile: string;
  openEntryMenu: (
    event: React.MouseEvent | React.KeyboardEvent,
    spec: ReturnType<typeof createSidebarEntryMenuSpec>,
  ) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const [mentionsOpen, setMentionsOpen] = useState(false);
  const [mentionState, dispatchMentions] = useReducer(mentionUiReducer, { status: 'idle' });
  const [cutoffOpen, setCutoffOpen] = useState(false);
  const [cutoffState, dispatchCutoff] = useReducer(
    memoryCutoffReducer,
    latestChapter,
    initialMemoryCutoffState,
  );
  const mentionRequestSeq = useRef(0);
  const activeProjectId = useStudio((s) => s.activeProjectId);
  const chapterLeaf = useStudio((s) =>
    s.projects.find((project) => project.config.id === s.activeProjectId)
      ?.config.contentTree.leaf);
  const openDocument = useStudio((s) => s.openDocument);
  const running = useStudio((s) => s.running);
  const agents = useStudio((s) => s.agents);
  const agentsLoaded = useStudio((s) => s.agentsLoaded);
  const startCharacterChat = useStudio((s) => s.startCharacterChat);
  const canChat = !running && agentsLoaded && agents.some(
    (agent) => agent.ok && agent.supportedProfiles.includes('writer'),
  );

  async function loadMentions(): Promise<void> {
    if (!activeProjectId) return;
    const projectId = activeProjectId;
    const requestSeq = ++mentionRequestSeq.current;
    dispatchMentions({ type: 'load' });
    try {
      const locations = await api.getMentions(projectId, card.name);
      if (requestSeq !== mentionRequestSeq.current) return;
      dispatchMentions({ type: 'success', locations: normalizeMentions(locations) });
    } catch (error) {
      if (requestSeq !== mentionRequestSeq.current) return;
      dispatchMentions({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function toggleMentions(): void {
    if (mentionsOpen) {
      setMentionsOpen(false);
      return;
    }
    showMentions();
  }

  function showMentions(): void {
    setMentionsOpen(true);
    if (mentionState.status === 'idle' || mentionState.status === 'error') void loadMentions();
  }

  function openCutoff(): void {
    dispatchCutoff({ type: 'select', mode: latestChapter === null ? 'none' : 'latest' });
    setCutoffOpen(true);
  }

  function confirmCutoff(): void {
    if (!isMemoryCutoffValid(cutoffState, latestChapter)) return;
    const cutoff = resolveMemoryCutoffChapter(cutoffState, latestChapter);
    setCutoffOpen(false);
    void startCharacterChat(card.name, cutoff);
  }

  const cardSection = sections.find((section) =>
    section.headingPath.length === 1 && section.headingPath[0] === card.name);
  const cardSpec = createSidebarEntryMenuSpec({
    label: card.name,
    sourceFile,
    source: null,
    showJump: false,
    repairSection: cardSection,
    actions: {
      repair: onRepair,
      copyName: async () => {
        await copyText(card.name, '词条名已复制');
      },
      copyEntry: async () => {
        await copyText(
          [
            card.name,
            ...card.sections.flatMap((section) =>
              section.heading
                ? [`## ${section.heading}`, section.body]
                : [section.body]),
          ].join('\n\n'),
          '词条已复制',
        );
      },
      showMentions,
    },
  });

  return (
    <div
      className="dto-card"
      data-canon-heading={card.name}
      tabIndex={0}
      onContextMenu={(event) => openEntryMenu(event, cardSpec)}
      onKeyDown={(event) => openEntryMenu(event, cardSpec)}
    >
      <div className="character-card-head">
        <button className="dto-accordion-head" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className={open ? 'tree-dir-caret open' : 'tree-dir-caret'}>
            <ChevronRightIcon size={13} />
          </span>
          <span className="character-name">{card.name}</span>
        </button>
        <button
          className="character-mentions-btn"
          aria-expanded={mentionsOpen}
          onClick={toggleMentions}
        >
          出现章节
        </button>
        <button
          className="character-chat-btn"
          title={`与「${card.name}」对话（写手视角，不含未来剧情）`}
          disabled={!canChat}
          onClick={openCutoff}
        >
          对话
        </button>
      </div>
      {mentionsOpen && (
        <MentionResults
          state={mentionState}
          onOpen={(docId) => void openDocument(docId)}
          onRetry={() => void loadMentions()}
          chapterLeaf={chapterLeaf}
        />
      )}
      {open &&
        card.sections.map((s, i) => (
          <div className="dto-subsection" key={`${s.heading}-${i}`}>
            {s.heading && (
              <div className="dto-subsection-head">
                {s.heading}
                <CanonRepairButton
                  section={sections.find((section) =>
                    section.headingPath.length === 2
                    && section.headingPath[0] === card.name
                    && section.headingPath[1] === s.heading)}
                  onRepair={onRepair}
                />
              </div>
            )}
            <div className="dto-body">{s.body}</div>
          </div>
        ))}
      <Modal
        open={cutoffOpen}
        title={`设置「${card.name}」的记忆截点`}
        confirmText="开始对话"
        confirmDisabled={!isMemoryCutoffValid(cutoffState, latestChapter)}
        onClose={() => setCutoffOpen(false)}
        onConfirm={confirmCutoff}
      >
        <div className="memory-cutoff-options">
          <label>
            <input
              type="radio"
              name={`memory-cutoff-${card.name}`}
              checked={cutoffState.mode === 'latest'}
              disabled={latestChapter === null}
              onChange={() => dispatchCutoff({ type: 'select', mode: 'latest' })}
            />
            最新章号{latestChapter === null ? '（未检测到）' : `（${formatChapterLabel(chapterLeaf, latestChapter)}）`}
          </label>
          <label>
            <input
              type="radio"
              name={`memory-cutoff-${card.name}`}
              checked={cutoffState.mode === 'custom'}
              onChange={() => dispatchCutoff({ type: 'select', mode: 'custom' })}
            />
            截止到第
            <input
              className="modal-input memory-cutoff-input"
              inputMode="numeric"
              aria-label="自定义记忆截点章号"
              value={cutoffState.customChapter}
              onChange={(event) => dispatchCutoff({ type: 'custom', value: event.target.value })}
            />
            章
          </label>
          <label>
            <input
              type="radio"
              name={`memory-cutoff-${card.name}`}
              checked={cutoffState.mode === 'none'}
              onChange={() => dispatchCutoff({ type: 'select', mode: 'none' })}
            />
            不截断
          </label>
          <p className="model-id-hint">
            只会自动移除带明确章号且晚于截点的资料；无章号标注的资料无法自动截断。
          </p>
        </div>
      </Modal>
    </div>
  );
}

export function CharacterCardView({
  cards,
  sections,
  onRepair,
  latestChapter,
  sourceFile,
}: {
  cards: CharacterCard[];
  sections: CanonSectionRef[];
  onRepair: (section: CanonSectionRef) => void;
  latestChapter: number | null;
  sourceFile: string;
}): React.JSX.Element {
  const menu = useContextMenu();

  function openEntryMenu(
    event: React.MouseEvent | React.KeyboardEvent,
    spec: ReturnType<typeof createSidebarEntryMenuSpec>,
  ): void {
    if ('clientX' in event) menu.openFromEvent(event, spec);
    else menu.openFromKeyboard(event, spec);
  }

  if (cards.length === 0) return <Empty text="暂无角色卡" />;
  return (
    <div className="dto-root">
      {cards.map((card, i) => (
        <Card
          key={card.name}
          card={card}
          defaultOpen={i === 0}
          sections={sections}
          onRepair={onRepair}
          latestChapter={latestChapter}
          sourceFile={sourceFile}
          openEntryMenu={openEntryMenu}
        />
      ))}
      <ContextMenu state={menu.state} onClose={menu.close} />
    </div>
  );
}
