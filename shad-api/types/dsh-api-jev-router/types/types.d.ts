/** JSON-safe inputs and results of the Jev router Remote namespace. */
import type { SessionId } from '../../dsh-session/types/index.js';
/** Prompt text that the Session is about to submit, identified by its Session. */
export interface JevRouteRequest {
    readonly sessionId: SessionId;
    readonly text: string;
}
/** Model route the router selected for the Session's next model step. */
export interface JevRouteSelection {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}
/** Outcome of one routing decision. */
export interface JevRouteResult {
    readonly routed: boolean;
    /** Index of the tier Jev chose, when Jev answered. */
    readonly tier?: number;
    /** Route the Session now uses, present when `routed` is true. */
    readonly selected?: JevRouteSelection;
    /** Why no switch happened: `disabled`, `unchanged`, or `jev-unavailable`. */
    readonly reason?: string;
}
