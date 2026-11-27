import { constructRecoveredModules } from './recovered-modules.mjs';
import { fileTransferPromptToolOverrides, wrapFileTransferPromptTools } from './file-transfer.mjs';

export async function installRecoveredPromptTools(library, directory) {
  const constructed = await constructRecoveredModules(
    library.promptToolsRecoveryPlan,
    wrapFileTransferPromptTools(library.getPromptToolsRecoveryBindings()),
    directory,
    'Prompt/tools',
    { overrides: fileTransferPromptToolOverrides() },
  );
  const bindings = library.installRecoveredPromptTools(constructed.bindings);
  return { installed: true, factoryLifetime: 'Once per Host process, after Computer/Box and before Harness construction',
    bindings, sharedBindings: library.promptToolsRecoveryPlan.modules.flatMap(module => module.sharedExports ?? []),
    modules: constructed.modules, originalDependencyCount: constructed.originalDependencyCount };
}
