import type { AgentAvailability, Project } from '@writing-studio/contract';

type SupportedProfile = AgentAvailability['supportedProfiles'][number];

export function pickPreferredAgent(
  agents: readonly AgentAvailability[],
  profile: SupportedProfile,
  defaultAgentId: Project['config']['defaultAgentId'],
): AgentAvailability | undefined {
  const usable = agents.filter(
    (agent) => agent.ok && agent.supportedProfiles.includes(profile),
  );
  return usable.find((agent) => agent.agentId === defaultAgentId)
    ?? usable.find((agent) => agent.agentId === 'echo')
    ?? usable[0];
}

interface EditorSnapshot {
  editorDirty: boolean;
  editorContent: string;
}

type SaveResult = 'saved' | 'saved-with-new-edits' | 'conflict';
type PushToast = (kind: 'warning' | 'danger', text: string) => void;

export async function saveDirtyEditorBeforeThreadAction(
  snapshot: EditorSnapshot,
  actionLabel: string,
  saveDocument: (content: string) => Promise<SaveResult>,
  pushToast: PushToast,
): Promise<'proceed' | 'aborted'> {
  if (!snapshot.editorDirty) return 'proceed';
  try {
    const saved = await saveDocument(snapshot.editorContent);
    if (saved === 'saved') return 'proceed';
    if (saved === 'conflict') {
      pushToast('warning', `保存冲突：请合并外部修改后再${actionLabel}`);
    } else {
      pushToast('warning', `保存期间正文继续变化，请再次保存后再${actionLabel}`);
    }
  } catch (error) {
    pushToast(
      'danger',
      `保存失败，未创建线程：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return 'aborted';
}

export class LatestRequestGate {
  private sequence = 0;
  private latestApplied = 0;

  begin(): number {
    this.sequence += 1;
    return this.sequence;
  }

  /**
   * Accept a successful result unless a newer successful result was already
   * applied. Merely starting (or later abandoning) a request must not
   * invalidate useful data from another in-flight request.
   */
  accept(token: number): boolean {
    if (token <= this.latestApplied) return false;
    this.latestApplied = token;
    return true;
  }

  /**
   * Non-mutating staleness probe for failure paths: once a newer result has
   * been applied, a stale request's failure is noise and should not surface.
   * (Unlike accept, this must not advance latestApplied — a failed request
   * must never block a slower, still-in-flight older success.)
   */
  isSuperseded(token: number): boolean {
    return token <= this.latestApplied;
  }
}

export interface PaneCollapseState {
  isNarrow: boolean;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
}

export type PaneSide = 'left' | 'right';

export function initialPaneState(
  narrow: boolean,
  desktopPreference: Pick<PaneCollapseState, 'leftCollapsed' | 'rightCollapsed'>,
): PaneCollapseState {
  return narrow
    ? { isNarrow: true, leftCollapsed: true, rightCollapsed: true }
    : { isNarrow: false, ...desktopPreference };
}

export function togglePane(
  state: PaneCollapseState,
  side: PaneSide,
): Pick<PaneCollapseState, 'leftCollapsed' | 'rightCollapsed'> {
  if (!state.isNarrow) {
    return side === 'left'
      ? { leftCollapsed: !state.leftCollapsed, rightCollapsed: state.rightCollapsed }
      : { leftCollapsed: state.leftCollapsed, rightCollapsed: !state.rightCollapsed };
  }

  if (side === 'left') {
    const opening = state.leftCollapsed;
    return {
      leftCollapsed: !opening,
      rightCollapsed: opening ? true : state.rightCollapsed,
    };
  }
  const opening = state.rightCollapsed;
  return {
    leftCollapsed: opening ? true : state.leftCollapsed,
    rightCollapsed: !opening,
  };
}

export function transitionViewport(
  state: PaneCollapseState,
  narrow: boolean,
  desktopPreference: Pick<PaneCollapseState, 'leftCollapsed' | 'rightCollapsed'>,
): PaneCollapseState | null {
  if (narrow === state.isNarrow) return null;
  return narrow
    ? { isNarrow: true, leftCollapsed: true, rightCollapsed: true }
    : { isNarrow: false, ...desktopPreference };
}
