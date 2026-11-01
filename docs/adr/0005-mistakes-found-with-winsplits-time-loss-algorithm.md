# Mistakes found with WinSplits' time-loss algorithm

The results list shows the legs where a runner made a mistake with a red background,
as WinSplits Online does.
Orienteers know that table, so the mistakes are found the way WinSplits Pro finds them
(its help, "Terms, concepts, and algorithms", under _Time loss_):

1. The reference time of a leg is the mean of the fastest quarter of its leg times,
   at least one, among the placed results shown.
2. A runner's performance index on a leg is the reference time divided by their leg time.
3. Their normal performance is the median of their performance indices, weighted by leg length.
   The help's English text says "medium value"; the Swedish text says _medianvärdet_.
4. Their normal leg time is the reference time divided by their normal performance,
   and the time loss is their leg time minus it.
5. A leg is a mistake when the time loss is above both 30 seconds
   and 20 % of the normal leg time.

Leg length is the straight line between the controls: a course has no other.
A run that is not on the list is measured against the list's reference times,
but is not one of them.
Mistakes are shown however few the results are; with one result there can be none.

The threshold is fixed, not a setting.
WinSplits lets the reader set it
(WinSplits Online starts at 0:00 and 0 %,
which marks every leg slower than the runner's normal leg time).
The results list has no settings bar,
and one threshold for everyone makes a red cell mean the same to every runner.

## Considered Options

- **The best leg time as reference**: simpler, but one lucky or short-cutting runner
  moves every other runner's normal leg time.
- **The mean of the indices, or the run time over the sum of reference times**:
  the mistakes themselves pull the normal performance down and hide smaller mistakes.
- **WinSplits Online's 0:00 and 0 %**: about half of all legs turn red,
  which shows where a runner was slower than usual, not where they made a mistake.
