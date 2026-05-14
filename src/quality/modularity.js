// Modularity quality and ΔQ helpers.
//
// Convention: communityInternalEdgeWeight counts each undirected edge once and each
// self-loop once. The classic Newman modularity is Q = (1/2m) Σ_c [2L_c - d_c²/(2m)]
// where L_c is internal edges counted once. Rewriting with m2 = 2m gives the form
// below: Q = Σ_c [2*L_c/m2 - (d_c/m2)²]. For directed graphs, L_c counts each directed
// edge once and m = totalWeight (no factor of 2), so the formula is the textbook
// Leicht–Newman one with a single m in the denominator.

export function diffModularity(part, g, v, c) {
	if (g.directed) return diffModularityDirected(part, g, v, c);
	const oldC = part.nodeCommunity[v];
	if (c === oldC) return 0;
	const k_v = g.strengthOut[v];
	const m2 = g.totalWeight;
	const k_v_in_new = part.getNeighborEdgeWeightToCommunity(c) || 0;
	const k_v_in_old = part.getNeighborEdgeWeightToCommunity(oldC) || 0;
	const wTot_new = c < part.communityTotalStrength.length ? part.communityTotalStrength[c] : 0;
	const wTot_old = part.communityTotalStrength[oldC];
	// (wTot_old - k_v): when v leaves oldC, oldC's strength drops by k_v. Omitting this
	// term biases all gains upward by the same constant (k_v²/m2²) and accepts moves
	// that should be rejected.
	const gain_remove = -(k_v_in_old / m2 - (k_v * (wTot_old - k_v)) / (m2 * m2));
	const gain_add    =  (k_v_in_new / m2 - (k_v * wTot_new) / (m2 * m2));
	return 2 * (gain_remove + gain_add);
}

export function diffModularityDirected(part, g, v, c) {
	const oldC = part.nodeCommunity[v];
	if (c === oldC) return 0;
	const m = g.totalWeight;
	const k_out = g.strengthOut[v];
	const k_in = g.strengthIn[v];
	const w_new_in = (c < g.n ? (part.getInEdgeWeightFromCommunity(c) || 0) : 0);
	const w_new_out = (c < g.n ? (part.getOutEdgeWeightToCommunity(c) || 0) : 0);
	const w_old_in = part.getInEdgeWeightFromCommunity(oldC) || 0;
	const w_old_out = part.getOutEdgeWeightToCommunity(oldC) || 0;
	const T_new = (c < part.communityTotalInStrength.length ? part.communityTotalInStrength[c] : 0);
	const F_new = (c < part.communityTotalOutStrength.length ? part.communityTotalOutStrength[c] : 0);
	const T_old = part.communityTotalInStrength[oldC];
	const F_old = part.communityTotalOutStrength[oldC];
	const deltaInternal = (w_new_in + w_new_out - w_old_in - w_old_out) / m;
	// Same asymmetry as the undirected case: subtract v's own contribution when computing
	// the old community's expected internal weight.
	const deltaExpected = (k_out * (T_new - (T_old - k_in)) + k_in * (F_new - (F_old - k_out))) / (m * m);
	return deltaInternal - deltaExpected;
}

export function qualityModularity(part, g) {
	const m2 = g.totalWeight;
	let sum = 0;
	if (g.directed) {
		for (let c = 0; c < part.communityCount; c++) sum += (part.communityInternalEdgeWeight[c] / m2) - ((part.communityTotalOutStrength[c] * part.communityTotalInStrength[c]) / (m2 * m2));
	} else {
		for (let c = 0; c < part.communityCount; c++) {
			const lc = part.communityInternalEdgeWeight[c];
			const dc = part.communityTotalStrength[c];
			// Factor of 2 on L because L counts each undirected edge once but the formula
			// is derived from the symmetric sum Σ_ij A_ij which counts each edge twice.
			sum += (2 * lc / m2) - (dc * dc) / (m2 * m2);
		}
	}
	return sum;
}
