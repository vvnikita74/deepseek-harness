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
    /** True while a user holds control and the agent's browser tools wait. */
    readonly userControl: boolean;
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
/**
 * Input forwarded to one tab as a user would produce it. Coordinates are CSS pixels of the page viewport;
 * `modifiers` is a bit mask: Alt 1, Ctrl 2, Meta 4, Shift 8.
 */
export type BrowserInputEvent = {
    readonly type: 'mouse';
    /** `move` sends no button; `down` and `up` press or release `button`. */
    readonly action: 'move' | 'down' | 'up';
    readonly x: number;
    readonly y: number;
    /** Defaults to `none` for `move` and `left` for `down`/`up`. */
    readonly button?: 'left' | 'middle' | 'right' | 'none';
    /** Bit mask of pressed buttons: left 1, right 2, middle 4. Defaults to the bit of `button` on `down`, else 0. */
    readonly buttons?: number;
    /** Click count, 0 to 3. Defaults to 1 on `down`/`up`, else 0. */
    readonly clickCount?: number;
    readonly modifiers?: number;
} | {
    readonly type: 'wheel';
    readonly x: number;
    readonly y: number;
    readonly deltaX: number;
    readonly deltaY: number;
    readonly modifiers?: number;
} | {
    readonly type: 'key';
    readonly action: 'down' | 'up';
    /** DOM `KeyboardEvent.key` value, 1 to 32 characters. */
    readonly key: string;
    /** DOM `KeyboardEvent.code` value, at most 32 characters. */
    readonly code: string;
    /** DOM `keyCode`, 0 to 255. */
    readonly keyCode: number;
    /** Characters the key produces, at most 8; `'\r'` for Enter. Absent or empty for keys that produce none. */
    readonly text?: string;
    readonly modifiers?: number;
}
/** Committed text, sent as `Input.insertText`; at most 20000 characters. */
 | {
    readonly type: 'text';
    readonly text: string;
}
/** Load a page in the tab; only `http:` and `https:` URLs are accepted. */
 | {
    readonly type: 'navigate';
    readonly url: string;
};
/** One input event addressed to an open tab. */
export interface BrowserInputRequest {
    /** DevTools target id of the tab that receives the event. */
    readonly targetId: string;
    readonly event: BrowserInputEvent;
}
declare module '../../dsh-typert-protocol/types/index.js' {
    interface RemoteErrorDetailsMap {
        /** No open tab has that target id. */
        'browser-view/tab-not-found': {
            readonly targetId: string;
        };
        /** The browser is not running or the tab is not attached yet. */
        'browser-view/unavailable': {};
    }
}
