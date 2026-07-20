export type SlashCommandCandidate = {
  name: string;
  description?: string;
};

export type ProviderSkill = {
  name: string;
  description?: string;
  command: string;
  scope: string;
  sourcePath?: string;
  pluginName?: string;
  pluginId?: string;
};

export type ProviderSkillSlashCommand = SlashCommandCandidate & {
  namespace: 'skill';
  path?: string;
  type: 'skill';
  metadata: {
    type: string;
    scope: string;
    sourcePath?: string;
    pluginName?: string;
    pluginId?: string;
    skillName: string;
  };
};

/** The active `/…` token under the caret, or null when none applies. */
export function getActiveSlashToken(text: string, caret: number): { start: number; query: string } | null {
  for (let index = caret - 1; index >= 0; index -= 1) {
    const char = text[index];
    if (char === '/') {
      const precededByBoundary = index === 0 || /\s/.test(text[index - 1]);
      if (!precededByBoundary) {
        return null;
      }
      const query = text.slice(index, caret);
      return /\s/.test(query) ? null : { start: index, query };
    }
    if (/\s/.test(char)) {
      return null;
    }
  }
  return null;
}

function filterSlashCommandCandidates<T extends SlashCommandCandidate>(
  commands: T[],
  query: string,
  requirePrefixAfterNamespace: boolean,
): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return commands;
  }

  const commandPrefix = normalizedQuery.startsWith('/')
    ? normalizedQuery
    : `/${normalizedQuery}`;
  const namePrefixMatches = commands.filter((command) =>
    command.name.toLowerCase().startsWith(commandPrefix),
  );
  if (requirePrefixAfterNamespace && normalizedQuery.includes(':')) {
    return namePrefixMatches;
  }
  if (namePrefixMatches.length > 0) {
    return namePrefixMatches;
  }

  const substringQuery = requirePrefixAfterNamespace ? normalizedQuery : commandPrefix.slice(1);
  const nameSubstringMatches = commands.filter((command) =>
    command.name.toLowerCase().includes(substringQuery),
  );
  if (nameSubstringMatches.length > 0) {
    return nameSubstringMatches;
  }
  return commands.filter((command) =>
    command.description?.toLowerCase().includes(substringQuery),
  );
}

/** Filters the standard command palette, preserving namespace path completion. */
export function filterSlashCommands<T extends SlashCommandCandidate>(commands: T[], query: string): T[] {
  return filterSlashCommandCandidates(commands, query, true);
}

/** Filters the live relay palette with its existing permissive fallback behavior. */
export function filterCommands<T extends SlashCommandCandidate>(commands: T[], query: string): T[] {
  if (query.trim() === '/') {
    return commands;
  }
  return filterSlashCommandCandidates(commands, query, false);
}

export function dedupeProviderSkills(skills: ProviderSkill[]): ProviderSkill[] {
  const seenCommands = new Set<string>();

  return skills.filter((skill) => {
    if (seenCommands.has(skill.command)) {
      return false;
    }
    seenCommands.add(skill.command);
    return true;
  });
}

export function mapSkillToSlashCommand(skill: ProviderSkill): ProviderSkillSlashCommand {
  return {
    name: skill.command,
    description: skill.description,
    namespace: 'skill',
    path: skill.sourcePath,
    type: 'skill',
    metadata: {
      type: skill.scope,
      scope: skill.scope,
      sourcePath: skill.sourcePath,
      pluginName: skill.pluginName,
      pluginId: skill.pluginId,
      skillName: skill.name,
    },
  };
}

export function insertSlashCommand(
  input: string,
  commandName: string,
  slashPosition: number,
  selectionStart: number,
  selectionEnd: number,
): { value: string; cursorPosition: number } {
  const insertionStart = slashPosition >= 0 ? slashPosition : selectionStart;
  const textBeforeCommand = input.slice(0, insertionStart);
  const textAfterCommandStart = input.slice(insertionStart);
  const spaceIndex = textAfterCommandStart.indexOf(' ');
  const textAfterCommand = slashPosition >= 0 && spaceIndex !== -1
    ? textAfterCommandStart.slice(spaceIndex).trimStart()
    : input.slice(selectionEnd);
  const separator = textBeforeCommand && !/\s$/.test(textBeforeCommand) ? ' ' : '';
  const commandWithSpace = `${textBeforeCommand}${separator}${commandName} `;

  return {
    value: `${commandWithSpace}${textAfterCommand}`,
    cursorPosition: commandWithSpace.length,
  };
}
