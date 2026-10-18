/** Injection token for the options passed to `RelayoModule.forRoot()` / `forRootAsync()`. */
export const RELAYO_OPTIONS = Symbol.for('relayo:options');
/** Injection token for the underlying `Relayo` instance created by `createRelayo()`. */
export const RELAYO_CLIENT = Symbol.for('relayo:client');
/** Metadata key set by `@OnRelayoEvent()`. */
export const RELAYO_EVENT_METADATA = 'relayo:on-event';
