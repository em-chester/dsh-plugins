/**
 * Host half of dsh-plugin-balance.
 *
 * The whole feature lives in the browser bundle (`./client`): the panel calls the
 * DeepSeek balance endpoint directly (its CORS policy echoes our origin), so no
 * host route, no credentials in the host process. Kept as a no-op so the loader
 * entry stays valid and the composition stays symmetric with other client plugins.
 */
export function apply() {}
