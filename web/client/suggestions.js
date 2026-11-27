// Web entry of the composer assist (suggestion strip, loading shimmer, inline completion and the
// first-level "Input suggestions" settings page). The implementation is shared with the desktop
// apps: mac/clients/desktop/composer-assist.cjs, packaged as client/desktop/composer-assist.js and
// imported by bridge.js before this module, which puts it on globalThis.RokBotComposerAssist.
// Never displays hardcoded static preset suggestions.

const assist = () => {
  const api = globalThis.RokBotComposerAssist;
  if (!api) throw new Error('RokBot composer assist is not loaded');
  return api;
};

export const isZhLocale = (...args) => assist().isZhLocale(...args);
export const extractComposerText = (...args) => assist().extractComposerText(...args);
export const composerDraft = (...args) => assist().composerDraft(...args);
export const insertSuggestionText = (...args) => assist().insertSuggestionText(...args);
export const appendComposerText = (...args) => assist().appendComposerText(...args);
export const sendSuggestionText = (...args) => assist().sendSuggestionText(...args);
export const mergeSuggestionItems = (...args) => assist().mergeSuggestionItems(...args);
export const matchCompletions = (...args) => assist().matchCompletions(...args);
export const createLoadingMachine = (...args) => assist().createLoadingMachine(...args);
export const createCompletionController = (...args) => assist().createCompletionController(...args);
export const installSuggestionsSettingsPage = (...args) => assist().installSuggestionsSettingsPage(...args);

/** The Web client: requests go through the Host gateway (request(path, body, signal, method)). */
export function installComposerSuggestions(options = {}) {
  if (typeof document === 'undefined' || typeof options.request !== 'function') return () => {};
  return assist().installComposerSuggestions(options);
}
