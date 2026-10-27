/**
 * Test and Preview, as functions any host can call: the web console in-request,
 * or a runner agent answering a probe (docs/runner-service-plan.md, decision 6).
 * One implementation, so the two paths cannot describe the same database
 * differently.
 */
export { describeConnectionFailure, safeErrorMessage } from './safe-error';
export { TEST_TIMEOUT_MS, testConnection } from './test-connection';
export type { ConnectionTestResult } from './test-connection';
export { PreviewConnectionError, inspectForPreview } from './inspect-for-preview';
export type { PreviewInspection } from './inspect-for-preview';
export { PROBE_VERSION, ProbeIncompatibleError, executeProbe, openProbe, readProbeResult, sealProbe } from './probe-wire';
export type { PreviewProbeResult, ProbeRequest, ProbeResult } from './probe-wire';
