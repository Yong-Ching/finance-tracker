/**
 * The categorical chart order (blue, orange, aqua, yellow, magenta, green),
 * colour-blind validated. Six at most: a seventh series folds into "Other".
 */
export const SERIES_COLORS = [1, 2, 3, 4, 5, 6].map((n) => `var(--series-${n})`);
