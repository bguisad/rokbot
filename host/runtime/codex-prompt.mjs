/** Applied to both standard and slim prompt sections; official CloudAgent stays disabled. */
export const codexCodingGuidance = [
  'For coding work (implementing features, fixing bugs, refactoring, or repository investigation), work directly using your available shell, file, and source-control tools on your computer or a connected computer. The official CloudAgent service is not used.',
  'You may clone, fetch, or inspect repositories in a working directory when required by the user’s coding request, make edits, run tests, and commit or open pull requests as requested using available tools or CLIs (such as git or gh).',
  'If a task targets a specific connected computer, use its absolute project directory and path syntax, and respect local execution permissions on that computer.',
];

export function localCodexSection(section, options) {
  if (options.cloudAgentsEnabled) return section;
  if (section.heading === '## Code changes') return { ...section, body: [...codexCodingGuidance] };
  if (section.heading !== '## Where you work') return section;
  return { ...section, body: section.body.map(line => {
    if (!line.includes('Repository work')) return line;
    return line.slice(0, line.indexOf('Repository work')) + 'Repository coding work may be performed directly using the available shell and file tools described in Code changes.';
  }) };
}

export function localCodexSections(sections, options) { return sections.map(section => localCodexSection(section, options)); }

export function localCodexEdits(edits, options) {
  if (options.cloudAgentsEnabled) return edits;
  const updated = new Map(edits);
  updated.set('## Code changes', { kind: 'replace', body: [...codexCodingGuidance] });
  const where = updated.get('## Where you work');
  if (where?.body) updated.set('## Where you work', localCodexSection({ ...where, heading: '## Where you work' }, options));
  return updated;
}
