export interface RegistryStats {
	count: number;
	maxIndex: number | null;
	minIndex: number | null;
}

export interface RegistryAnalysis {
	contiguous: boolean;
	expectedMatches: boolean;
	normalizedExpected?: number;
	needsReconciliation: boolean;
}

export function analyzeRegistryState(
	stats: RegistryStats,
	expectedTickets?: number,
): RegistryAnalysis {
	const contiguous = stats.maxIndex === null || stats.minIndex === null
		? stats.count === 0
		: stats.maxIndex - stats.minIndex + 1 === stats.count;

	const expectedMatches = expectedTickets === undefined
		? true
		: stats.count === expectedTickets;

	const normalizedExpectedRaw = expectedTickets ?? (
		stats.maxIndex !== null ? stats.maxIndex + 1 : stats.count
	);

	const normalizedExpected = normalizedExpectedRaw > 0
		? normalizedExpectedRaw
		: undefined;

	return {
		contiguous,
		expectedMatches,
		normalizedExpected,
		needsReconciliation: !contiguous || !expectedMatches,
	};
}

export function summarizeTicketAssignments(
	assignments: Map<number, string>,
): {
	orderedEntries: Array<[number, string]>;
	stats: RegistryStats;
} {
	const orderedEntries = [...assignments.entries()].sort((a, b) => a[0] - b[0]);
	const hasEntries = orderedEntries.length > 0;
	const maxIndex = hasEntries ? orderedEntries[orderedEntries.length - 1]![0] : null;
	const minIndex = hasEntries ? orderedEntries[0]![0] : null;

	return {
		orderedEntries,
		stats: {
			count: orderedEntries.length,
			maxIndex,
			minIndex,
		},
	};
}
