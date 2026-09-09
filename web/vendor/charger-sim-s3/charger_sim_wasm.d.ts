/* tslint:disable */
/* eslint-disable */

export function board_json(): string;

/**
 * Feed a broker message through the real contract decoder. Ignored
 * topics (other boxes, unknown chargers) return false.
 */
export function on_mqtt(topic: string, payload: string): boolean;

/**
 * Per-charger output state (the "LED matrix"): same computation as
 * the device loop's `active[]` that drives relays/backlight.
 */
export function outputs_json(): string;

export function start(): void;

/**
 * Messages the firmware would have published since the last call —
 * the page shows them as the protocol log next to the canvas.
 */
export function take_outbox(): any[];

/**
 * 10 Hz heartbeat from the page — mirrors the device loop cadence.
 */
export function tick(): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly board_json: () => [number, number];
    readonly on_mqtt: (a: number, b: number, c: number, d: number) => number;
    readonly outputs_json: () => [number, number];
    readonly start: () => void;
    readonly take_outbox: () => [number, number];
    readonly tick: () => void;
    readonly send_keyboard_string_sequence: (a: number, b: number) => void;
    readonly slint_get_mocked_time: () => bigint;
    readonly slint_mock_elapsed_time: (a: bigint) => void;
    readonly slint_send_keyboard_char: (a: number, b: number, c: number) => void;
    readonly slint_send_keyboard_key_text: (a: number, b: number, c: number) => void;
    readonly slint_send_mouse_click: (a: number, b: number, c: number) => void;
    readonly wasm_bindgen_4fefa1f1c93be457___convert__closures_____invoke___wasm_bindgen_4fefa1f1c93be457___JsValue__core_ed718c3d60ebd546___result__Result_____wasm_bindgen_4fefa1f1c93be457___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen_4fefa1f1c93be457___convert__closures_____invoke___js_sys_754b130e08103384___Array__web_sys_e78a46e14447faa7___features__gen_ResizeObserver__ResizeObserver______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_4fefa1f1c93be457___convert__closures_____invoke___wasm_bindgen_4fefa1f1c93be457___JsValue______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_4fefa1f1c93be457___convert__closures_____invoke___wasm_bindgen_4fefa1f1c93be457___JsValue______true__3: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_4fefa1f1c93be457___convert__closures_____invoke___web_sys_e78a46e14447faa7___features__gen_InputEvent__InputEvent______true_: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_4fefa1f1c93be457___convert__closures_____invoke___web_sys_e78a46e14447faa7___features__gen_InputEvent__InputEvent______true__5: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_4fefa1f1c93be457___convert__closures_____invoke___wasm_bindgen_4fefa1f1c93be457___JsValue______true__6: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_4fefa1f1c93be457___convert__closures_____invoke___web_sys_e78a46e14447faa7___features__gen_InputEvent__InputEvent______true__7: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_4fefa1f1c93be457___convert__closures_____invoke___wasm_bindgen_4fefa1f1c93be457___JsValue______true__8: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_4fefa1f1c93be457___convert__closures_____invoke___web_sys_e78a46e14447faa7___features__gen_InputEvent__InputEvent______true__9: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_4fefa1f1c93be457___convert__closures_____invoke___wasm_bindgen_4fefa1f1c93be457___JsValue______true__10: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_4fefa1f1c93be457___convert__closures_____invoke___web_sys_e78a46e14447faa7___features__gen_InputEvent__InputEvent______true__11: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_4fefa1f1c93be457___convert__closures_____invoke___wasm_bindgen_4fefa1f1c93be457___JsValue______true__12: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_4fefa1f1c93be457___convert__closures_____invoke___wasm_bindgen_4fefa1f1c93be457___JsValue______true__13: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_4fefa1f1c93be457___convert__closures_____invoke___web_sys_e78a46e14447faa7___features__gen_InputEvent__InputEvent______true__14: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_4fefa1f1c93be457___convert__closures_____invoke___wasm_bindgen_4fefa1f1c93be457___JsValue______true__15: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen_4fefa1f1c93be457___convert__closures_____invoke_______true_: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
