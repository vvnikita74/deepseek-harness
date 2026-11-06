/** JSON-safe frame of the provider limits Remote namespace. */
import type { ProviderLimits } from '../../dsh-llm/types/index.js';
/** One frame of the `providerLimits/follow` stream. Each frame replaces the list the reader holds. */
export interface ProviderLimitsFrame {
    /** `snapshot` opens the stream; `update` follows each change of the reported providers. */
    readonly type: 'snapshot' | 'update';
    /** Every reported provider route with at least one window, as read when the frame was built. */
    readonly limits: readonly ProviderLimits[];
}
