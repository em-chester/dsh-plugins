/**
 * Host half of dsh-plugin-hud.
 *
 * Everything visual lives in the browser bundle (`./client`). The host half stays
 * a no-op so the loader entry is valid and the composition matches other
 * client-only plugins.
 */
export function apply() {}
