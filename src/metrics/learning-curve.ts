/**
 * akm-bench learning-curve metrics (#265).
 */

// ── Learning curve across episodes (§6.4 extension, issue #265) ────────────

/**
 * Episode-level Track B record. One record per evolution pass:
 * `episode_index === 0` is the pre-evolution baseline; subsequent indices
 * are the post-each-pass measurements.
 *
 * Cumulative counters are running totals AT THE END of `episode_index`
 * (i.e. inclusive). Per-episode deltas are derived in `computeLearningCurve`
 * — the record itself only carries the running totals so callers can supply
 * either cumulative or per-episode raw inputs without ambiguity.
 *
 * `lesson_reuse_rate` mirrors #264's lesson-quality aggregate for this
 * episode (NOT a delta). When an episode has not yet recorded any lesson
 * applications the caller passes `null`.
 */
export interface EpisodeRecord {
  episode_index: number;
  pass_rate: number;
  /** `pass_rate(i) - pass_rate(i-1)`; `0` for `episode_index === 0`. */
  delta_from_previous_episode: number;
  cumulative_feedback_events: number;
  cumulative_proposals_created: number;
  cumulative_proposals_accepted: number;
  cumulative_lessons_created: number;
  /** Reuse rate from #264's lesson aggregate; `null` when no data yet. */
  lesson_reuse_rate: number | null;
}

/** Threshold above `pass_rate[0]` that defines "improvement" for §6.4. */
export const LEARNING_IMPROVEMENT_THRESHOLD = 0.05;

/**
 * Aggregate learning-curve metrics across an evolution episode sequence.
 *
 * Output:
 * - `episodes`: echo of the input with `delta_from_previous_episode`
 *   recomputed defensively (callers may supply raw 0s for episode 0).
 * - `pass_rate_by_episode`: array indexed by `episode_index`.
 * - `learning_slope`: standard least-squares regression slope of pass rate
 *   against episode index. Returns `0` for a single-episode (degenerate)
 *   input where the regressor variance is zero.
 * - `time_to_improvement`: smallest `i` where
 *   `pass_rate[i] > pass_rate[0] + LEARNING_IMPROVEMENT_THRESHOLD`. `null`
 *   when no such episode exists.
 *
 * Empty input is rejected by returning a degenerate envelope with
 * `learning_slope = 0` and `time_to_improvement = null`. Callers that
 * supply unsorted episodes get back a stable-sorted copy keyed on
 * `episode_index`.
 */
export interface LearningCurve {
  episodes: EpisodeRecord[];
  pass_rate_by_episode: number[];
  learning_slope: number;
  time_to_improvement: number | null;
}

export function computeLearningCurve(episodes: ReadonlyArray<EpisodeRecord>): LearningCurve {
  // Stable sort by episode_index — defensive against unordered inputs.
  const sorted = [...episodes].sort((a, b) => a.episode_index - b.episode_index);

  // Recompute per-episode deltas so the contract holds regardless of what
  // the caller stamped on the input record.
  const normalised: EpisodeRecord[] = sorted.map((ep, i) => {
    const prev = i === 0 ? null : sorted[i - 1];
    const delta = prev === null ? 0 : ep.pass_rate - prev.pass_rate;
    return { ...ep, delta_from_previous_episode: delta };
  });

  const passRateByEpisode = normalised.map((ep) => ep.pass_rate);

  // Linear regression slope: sum((xi - x_mean) * (yi - y_mean)) /
  // sum((xi - x_mean)^2). For a single episode the denominator is 0 — we
  // return 0 (no observable trend) rather than NaN.
  const n = normalised.length;
  let learningSlope = 0;
  if (n >= 2) {
    const xs = normalised.map((ep) => ep.episode_index);
    const xMean = xs.reduce((s, v) => s + v, 0) / n;
    const yMean = passRateByEpisode.reduce((s, v) => s + v, 0) / n;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i += 1) {
      const dx = xs[i] - xMean;
      const dy = passRateByEpisode[i] - yMean;
      num += dx * dy;
      den += dx * dx;
    }
    learningSlope = den === 0 ? 0 : num / den;
  }

  // time_to_improvement: smallest episode_index strictly greater than
  // `pass_rate[0] + threshold`. Episode 0 itself is excluded — improvement
  // is only meaningful relative to baseline.
  let timeToImprovement: number | null = null;
  if (n >= 2) {
    const baseline = passRateByEpisode[0];
    for (let i = 1; i < n; i += 1) {
      if (passRateByEpisode[i] > baseline + LEARNING_IMPROVEMENT_THRESHOLD) {
        timeToImprovement = normalised[i].episode_index;
        break;
      }
    }
  }

  return {
    episodes: normalised,
    pass_rate_by_episode: passRateByEpisode,
    learning_slope: learningSlope,
    time_to_improvement: timeToImprovement,
  };
}
