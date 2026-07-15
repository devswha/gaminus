import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';
import { addUniqueProviderSkillSource } from '@/shared/utils.js';

export class GjcSkillsProvider extends SkillsProvider {
  constructor() {
    super('gjc');
  }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();

    // Project-scoped skills live under the workspace `.gjc/skills` folder.
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'project',
      rootDir: path.join(workspacePath, '.gjc', 'skills'),
      commandPrefix: '/',
    });

    // User-scoped skills live under the gjc agent home.
    addUniqueProviderSkillSource(sources, seenRootDirs, {
      scope: 'user',
      rootDir: path.join(os.homedir(), '.gjc', 'agent', 'skills'),
      commandPrefix: '/',
    });

    return sources;
  }
}
