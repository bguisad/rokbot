import { constructRecoveredModules } from './recovered-modules.mjs';
import { wrapPublishTranscriptMutation } from './content-search.mjs';

export async function installRecoveredStorage(library, directory) {
  const original = { ...library.getStorageRecoveryBindings() };
  if (typeof original.publishTranscriptMutation === 'function') {
    original.publishTranscriptMutation = wrapPublishTranscriptMutation(original.publishTranscriptMutation);
  }
  const constructed = await constructRecoveredModules(library.storageRecoveryPlan,
    original, directory, 'Storage');
  const bindings = library.installRecoveredStorage(constructed.bindings);
  return { installed: true,
    factoryLifetime: 'Once per Host process, after Host flow and before engine and service construction',
    bindings, sharedBindings: library.storageRecoveryPlan.modules.flatMap(module => module.sharedExports ?? []),
    modules: constructed.modules, originalDependencyCount: constructed.originalDependencyCount };
}
