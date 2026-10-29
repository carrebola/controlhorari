/** Match a remote Timenet mark to an unresolved automatic job (one claim per job). */
export type UncertainJob = { id: string; local_date: string; action: string };

export function claimUncertainJob(
  jobs: UncertainJob[],
  localDate: string,
  action: string,
  claimed: Set<string>,
): UncertainJob | undefined {
  const job = jobs.find((candidate) =>
    candidate.local_date === localDate && candidate.action === action && !claimed.has(candidate.id));
  if (job) claimed.add(job.id);
  return job;
}
