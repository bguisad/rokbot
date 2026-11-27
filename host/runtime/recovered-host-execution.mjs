import { combineRecoveryPlans, constructRecoveredModules } from './recovered-modules.mjs';
import { withLocalLibraryRunner } from './host-library-files.mjs';
import { wrapPublishTranscriptMutation } from './content-search.mjs';
import {
  wrapResolveNamedActivityHold,
  wrapRunLifecycle,
  wrapTurnRuntime,
} from './turn-continuity.mjs';

export async function installRecoveredHostExecutionAndSession(library, directory) {
  const plans = [library.hostExecutionRecoveryPlan, library.hostSessionRecoveryPlan];
  const original = library.getHostExecutionRecoveryBindings();
  for (const [name, value] of Object.entries(library.getHostSessionRecoveryBindings())) {
    if (Object.hasOwn(original, name) && original[name] !== value) throw new Error(`Inconsistent recovery identity: ${name}`);
    original[name] = value;
  }
  if (typeof original.SandAgentRunner !== 'function') {
    throw new TypeError('Missing Host execution dependency: SandAgentRunner');
  }
  const plan = combineRecoveryPlans(plans);
  original.SandAgentRunner = withLocalLibraryRunner(original.SandAgentRunner, library);

  if (typeof original.resolveNamedActivityHold === 'function') {
    if (!original.INITIAL_NAMED_ACTIVITY_HOLD_STATE || typeof original.INITIAL_NAMED_ACTIVITY_HOLD_STATE !== 'object') {
      throw new TypeError('Missing Host execution dependency: INITIAL_NAMED_ACTIVITY_HOLD_STATE');
    }
    original.resolveNamedActivityHold = wrapResolveNamedActivityHold(
      original.resolveNamedActivityHold,
      original.INITIAL_NAMED_ACTIVITY_HOLD_STATE,
    );
  }
  if (typeof original.publishTranscriptMutation === 'function') {
    original.publishTranscriptMutation = wrapPublishTranscriptMutation(original.publishTranscriptMutation);
  }

  const overrides = {
    RunLifecycle: recovered => wrapRunLifecycle(recovered),
  };
  const exportsTurnRuntime = plan.modules?.some(
    module => Array.isArray(module.exports) && module.exports.includes('TurnRuntime'),
  );
  if (exportsTurnRuntime) {
    if (typeof original.setTurnTraceAttributes !== 'function') {
      throw new TypeError('Missing Host execution dependency: setTurnTraceAttributes');
    }
    overrides.TurnRuntime = recovered => wrapTurnRuntime(recovered, {
      setTurnTraceAttributes: original.setTurnTraceAttributes,
    });
  }

  const constructed = await constructRecoveredModules(plan, original, directory, 'Host execution/session', {
    overrides,
  });
  // Both groups are validated and constructed before changing either bundle group.
  const sessionBindings = library.installRecoveredHostSession(constructed.bindings);
  const executionBindings = library.installRecoveredHostExecution(constructed.bindings);
  const describe = (source, bindings) => {
    const files = new Set(source.modules.map(module => module.name));
    const modules = constructed.modules.filter(module => files.has(module.file));
    return { installed: true, factoryLifetime: 'Once per Host process, jointly ordered after Harness and before SandHost construction',
      bindings, modules, originalDependencyCount: new Set(plan.modules.filter(module => files.has(module.name))
        .flatMap(module => module.originalDependencies)).size };
  };
  return { hostExecution: describe(plans[0], executionBindings), hostSession: describe(plans[1], sessionBindings),
    jointFactoryOrder: plan.modules.map(module => module.name) };
}
