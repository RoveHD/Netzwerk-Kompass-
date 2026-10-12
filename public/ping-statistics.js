const validValue = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

export function jitterFor(values) {
  const points = Array.isArray(values) ? values : [];
  let previous = null;
  return points.map(point => {
    const at = timestamp(point?.at);
    const value = point?.status !== 'measurement_error' && validValue(point?.value) ? point.value : null;
    let jitter = null;
    if (point?.status === 'measurement_error') previous = null;
    else if (at !== null && value !== null) {
      if (previous && point.epoch === previous.epoch) {
        const gap = at - previous.at;
        if (gap >= 0 && gap <= 10000) jitter = Math.abs(value - previous.value);
      }
      previous = { at, epoch: point.epoch, value };
    } else previous = null;
    return { at: point?.at ?? null, epoch: point?.epoch, value: jitter };
  });
}

export function summarizePingHistory(values) {
  const points = Array.isArray(values) ? values : [];
  const validPoints = points.map(point => ({ point, at: timestamp(point?.at) })).filter(item => item.at !== null);
  const errors = validPoints.filter(({ point }) => point?.status === 'measurement_error').length;
  const attempts = validPoints.length - errors;
  const answers = validPoints.filter(({ point }) => point?.status !== 'measurement_error' && validValue(point?.value));
  const pingValues = answers.map(({ point }) => point.value);
  const jitterPoints = jitterFor(points).filter(point => validValue(point.value));
  const mean = list => list.length ? list.reduce((average, value, index) => average + (value - average) / (index + 1), 0) : null;

  let peakPing = null;
  for (const { point } of answers) if (!peakPing || point.value > peakPing.value) peakPing = { value: point.value, at: point.at };
  let peakJitter = null;
  for (const point of jitterPoints) if (!peakJitter || point.value > peakJitter.value) peakJitter = { value: point.value, at: point.at };

  const minutes = new Map();
  for (const { point, at } of validPoints) {
    if (point?.status === 'measurement_error') continue;
    let epochMinutes = minutes.get(point.epoch);
    if (!epochMinutes) minutes.set(point.epoch, epochMinutes = new Map());
    const minute = Math.floor(at / 60000) * 60000;
    let bucket = epochMinutes.get(minute);
    if (!bucket) epochMinutes.set(minute, bucket = { lost: 0, attempts: 0 });
    bucket.attempts++;
    if (!validValue(point?.value)) bucket.lost++;
  }
  let peakLoss = null;
  for (const epochMinutes of minutes.values()) for (const [minute, bucket] of epochMinutes) {
    if (!bucket.attempts) continue;
    const loss = { value: 100 * bucket.lost / bucket.attempts, at: new Date(minute).toISOString(), lost: bucket.lost, attempts: bucket.attempts };
    if (!peakLoss || bucket.lost * peakLoss.attempts > peakLoss.lost * bucket.attempts || (bucket.lost * peakLoss.attempts === peakLoss.lost * bucket.attempts && bucket.attempts > peakLoss.attempts)) peakLoss = loss;
  }

  return {
    counts: { samples: validPoints.length, answers: answers.length, errors, attempts },
    averagePing: mean(pingValues),
    averageJitter: mean(jitterPoints.map(point => point.value)),
    lossPercent: attempts ? 100 * (attempts - answers.length) / attempts : null,
    peakPing,
    peakJitter,
    peakLoss,
  };
}
