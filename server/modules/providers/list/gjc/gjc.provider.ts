import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { GjcProviderAuth } from '@/modules/providers/list/gjc/gjc-auth.provider.js';
import { GjcProviderModels } from '@/modules/providers/list/gjc/gjc-models.provider.js';
import { GjcMcpProvider } from '@/modules/providers/list/gjc/gjc-mcp.provider.js';
import { GjcSessionSynchronizer } from '@/modules/providers/list/gjc/gjc-session-synchronizer.provider.js';
import { GjcSessionsProvider } from '@/modules/providers/list/gjc/gjc-sessions.provider.js';
import { GjcSkillsProvider } from '@/modules/providers/list/gjc/gjc-skills.provider.js';
import type {
  IProviderAuth,
  IProviderModels,
  IProviderSessionSynchronizer,
  IProviderSkills,
  IProviderSessions,
} from '@/shared/interfaces.js';

export class GjcProvider extends AbstractProvider {
  readonly models: IProviderModels = new GjcProviderModels();
  readonly mcp = new GjcMcpProvider();
  readonly auth: IProviderAuth = new GjcProviderAuth();
  readonly skills: IProviderSkills = new GjcSkillsProvider();
  readonly sessions: IProviderSessions = new GjcSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new GjcSessionSynchronizer();

  constructor() {
    super('gjc');
  }
}
