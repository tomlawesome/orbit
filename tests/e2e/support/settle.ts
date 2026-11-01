/**
 * #1447: UI settling is waited for, never timed. This is the bound on such a
 * wait -- 20 s, far beyond what any reader would feel -- for every `timeout`
 * on an expectation, poll or wait for the page to come to rest (T-Q7). Raise
 * it here, once.
 */
export const SETTLE = 20_000;
