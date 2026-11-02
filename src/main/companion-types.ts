/**
 * The companion's types live in src/shared/companion.ts, where the renderer can reach
 * them too (its tsconfig does not include src/main). Kept so main-process modules keep
 * importing from beside them.
 */
export * from '../shared/companion'
