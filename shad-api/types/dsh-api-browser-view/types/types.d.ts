/** Wire types of the browser-view Remote namespace. Pointer coordinates are CSS pixels in the page viewport. */
/** Watch options; omitting `targetId` follows the active tab. */
export interface BrowserViewWatchRequest {
    /** Tab to pin; the stream then carries only that tab and ends when it closes. */
    readonly targetId?: string;
}
/** One page tab of the shared browser. */
export interface BrowserViewTab {
    /** DevTools target id of the page. */
    readonly targetId: string;
    /** Current document URL. */
    readonly url: string;
    /** Current document title. */
    readonly title: string;
    /** Whether this tab is the one followed by a watch without `targetId`. */
    readonly active: boolean;
}
/** Browser process status and tab roster. */
export interface BrowserViewState {
    /** `disabled` without an executable; `failed` after the restart budget is spent. */
    readonly status: 'disabled' | 'starting' | 'ready' | 'restarting' | 'failed';
    /** Page tabs in creation order. */
    readonly tabs: readonly BrowserViewTab[];
    /** Tab followed by unpinned watches; absent when no page exists. */
    readonly activeTargetId?: string;
    /** Configured viewport in CSS pixels. */
    readonly viewport: {
        readonly width: number;
        readonly height: number;
    };
}
/** Element under a pointer, key, or input event. */
export interface BrowserViewElement {
    /** Lower-case tag name. */
    readonly tag: string;
    /** Trimmed text content, at most 80 characters. */
    readonly text?: string;
    /** Bounding box in CSS pixels of the page viewport. */
    readonly rect: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
    };
}
/** DevTools frame metadata of one frame. */
export interface BrowserViewFrameMetadata {
    readonly deviceWidth: number;
    readonly deviceHeight: number;
    readonly pageScaleFactor: number;
    readonly scrollOffsetX: number;
    readonly scrollOffsetY: number;
}
/** Stream item of a watch. */
export type BrowserViewEvent = {
    readonly type: 'state';
    readonly state: BrowserViewState;
} | {
    readonly type: 'frame';
    readonly targetId: string;
    /** Per-tab frame counter. */
    readonly seq: number;
    /** Epoch milliseconds when the server stored the frame. */
    readonly ts: number;
    /** JPEG bytes, scaled to the configured screencast width. */
    readonly jpegBase64: string;
    /** DevTools screencast metadata; `deviceWidth`/`deviceHeight` map CSS pixels to frame pixels. */
    readonly metadata: BrowserViewFrameMetadata;
} | {
    readonly type: 'pointer';
    readonly targetId: string;
    readonly ts: number;
    readonly kind: 'move' | 'down' | 'up' | 'click' | 'wheel';
    /** Pointer position in CSS pixels of the page viewport. */
    readonly x: number;
    readonly y: number;
    /** Mouse button index as reported by the DOM event. */
    readonly button?: number;
    readonly target?: BrowserViewElement;
} | {
    readonly type: 'key';
    readonly targetId: string;
    readonly ts: number;
    readonly key: string;
    readonly code: string;
    /** Bit mask: Alt 1, Ctrl 2, Meta 4, Shift 8. */
    readonly modifiers: number;
    readonly target?: BrowserViewElement;
} | {
    readonly type: 'input';
    readonly targetId: string;
    readonly ts: number;
    /** Field value truncated to 200 characters; absent for password fields. */
    readonly value?: string;
    readonly target?: BrowserViewElement;
} | {
    readonly type: 'navigation';
    readonly targetId: string;
    readonly ts: number;
    readonly url: string;
    /** Title known when the navigation committed; a later `state` event carries the settled title. */
    readonly title: string;
};
