import type { ProjectConfig } from '@writing-studio/contract';

export type MdNode = {
  type: string;
  depth?: number;
  value?: string;
  children?: MdNode[];
  align?: Array<'left' | 'right' | 'center' | null>;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
};

export type SidebarRole = 'writer' | 'planner';

export interface SidebarProject {
  vaultRoot: string;
  config: Pick<ProjectConfig, 'sidebarSources' | 'localePreset'>;
}

export type SidebarUpdated = (sourceId: string) => void;
